/**
 * 认证与账号路由（A2）：注册（两步）、登录（PoW 条件网关 + MFA 状态机挂点）、
 * 登出、找回密码、改密、/me。全事件审计。
 * 安全要点（移植自参考实现 routes/auth.js）：
 *  - 登录失败计数 / IP 自动封禁（security.ts）；
 *  - PoW：注册/找回恒要求（写入口），登录按 needsPow 条件要求；
 *  - Turnstile 可选启用，默认 PoW 兜底；
 *  - 用户不存在也执行等量 scrypt（dummyVerify），防用户名枚举；
 *  - 找回密码「存在与否」响应一致，防枚举。
 */
import { Router } from 'express';
import { and, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm';
import type { PublicUser, SessionInfo } from '@aap/shared';
import { getDb } from '../db/index.js';
import { inviteCodes, localCredentials, registrations, sessions, users, userGroupMembers } from '../db/schema.js';
import { HttpError, h } from '../lib/httpError.js';
import { dummyVerify, hashPassword, randomToken, verifyPassword } from '../lib/passwords.js';
import { consumePowToken, isBanned, needsPow, recordFailure, recordSuccess } from '../lib/security.js';
import { issueChallenge, verifyPow } from '../lib/pow.js';
import { createSession, destroySession, markStepUp } from '../lib/session.js';
import { getSetting, getSettingInt } from '../lib/settings.js';
import { verifyTurnstile, turnstileEnabled } from '../lib/turnstile.js';
import { issueCode, maskEmail, verifyCode } from '../lib/verification.js';
import { buildLoginRedirect, exchangeCallback, isAdminSubject } from '../lib/oidc.js';
import { adminCount, disposeCredentialsFile, getLocalPasswordHash, writeLocalCredentials } from '../lib/bootstrap.js';
import { audit, registerPurgeTask } from '../lib/audit.js';
import { publicUserOf } from './shared.js';

export const authRouter = Router();

const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- PoW 挑战（公开；内存限速防 SQLite 写放大） ----------

const POW_RATE = { windowMs: 60_000, max: 30 };
const powHits = new Map<string, { start: number; count: number }>();

function powRateAllowed(ip: string): boolean {
  const now = Date.now();
  const rec = powHits.get(ip);
  if (!rec || now - rec.start >= POW_RATE.windowMs) {
    powHits.set(ip, { start: now, count: 1 });
    if (powHits.size > 10_000) {
      for (const [k, v] of powHits) if (now - v.start >= POW_RATE.windowMs) powHits.delete(k);
    }
    return true;
  }
  rec.count++;
  return rec.count <= POW_RATE.max;
}

authRouter.post(
  '/auth/pow',
  h(async (req, res) => {
    const ip = req.clientIp ?? 'unknown';
    if (isBanned(ip)) throw new HttpError(403, 'IP_BANNED', '该地址已被封禁', { action: 'banned' });
    if (!powRateAllowed(ip)) throw new HttpError(429, 'TOO_MANY_REQUESTS', '请求太频繁');
    res.json({ challenge: issueChallenge(ip) });
  }),
);

authRouter.post(
  '/auth/pow/verify',
  h(async (req, res) => {
    const ip = req.clientIp ?? 'unknown';
    if (!powRateAllowed(ip)) throw new HttpError(429, 'TOO_MANY_REQUESTS', '请求太频繁');
    const { challengeId, nonce } = (req.body ?? {}) as { challengeId?: string; nonce?: string };
    const result = verifyPow(String(challengeId ?? ''), String(nonce ?? ''), ip);
    if (!result.ok) throw new HttpError(403, result.error, '工作量证明校验未通过');
    res.json({ token: result.token, ttlSec: getSettingInt('POW_TOKEN_TTL', 300) });
  }),
);

// ---------- 共用小工具 ----------

interface PowBody {
  powToken?: string;
  turnstileToken?: string;
}

/** PoW 网关：always=true 恒要求（注册/找回写入口）；否则仅失败超阈值后要求（登录） */
function enforcePow(req: Express.Request, body: PowBody, always: boolean): void {
  const ip = req.clientIp ?? 'unknown';
  if (!always && !needsPow(ip)) return;
  if (body.powToken && consumePowToken(body.powToken, ip)) return;
  throw new HttpError(403, 'POW_REQUIRED', '需要完成工作量证明（PoW）', {
    action: 'pow',
    challenge: issueChallenge(ip),
  });
}

async function enforceTurnstile(req: Express.Request, body: PowBody): Promise<void> {
  if (!turnstileEnabled()) return;
  const ok = await verifyTurnstile(body.turnstileToken, req.clientIp ?? 'unknown');
  if (!ok) throw new HttpError(403, 'TURNSTILE_FAILED', '人机验证未通过', { action: 'turnstile' });
}


function loadUserById(id: number) {
  const row = getDb().select().from(users).where(eq(users.id, id)).get();
  if (!row) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
  return row;
}

function loadUserByUsername(username: string) {
  return getDb()
    .select()
    .from(users)
    .where(and(eq(users.username, username), eq(users.kind, 'local')))
    .get();
}

// ---------- 注册（两步） ----------

authRouter.post(
  '/auth/register/start',
  h(async (req, res) => {
    const ip = req.clientIp ?? 'unknown';
    const mode = registrationMode();
    if (mode === 'closed') {
      throw new HttpError(403, 'REGISTRATION_CLOSED', '本站未开放注册');
    }
    const body = (req.body ?? {}) as {
      username?: string;
      password?: string;
      email?: string;
      inviteCode?: string;
    } & PowBody;

    enforcePow(req, body, true);
    await enforceTurnstile(req, body);

    const username = String(body.username ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, 'INVALID_USERNAME', '用户名需 3-64 位小写字母/数字/_.- 且以字母或数字开头');
    }
    if (password.length < 8 || password.length > 128) {
      throw new HttpError(400, 'INVALID_PASSWORD', '密码长度需 8-128 位');
    }
    if (!EMAIL_RE.test(email)) {
      throw new HttpError(400, 'INVALID_EMAIL', '邮箱格式不正确');
    }

    // 邀请码校验（invite 档）
    let inviteCode: string | null = null;
    if (mode === 'invite') {
      const code = String(body.inviteCode ?? '').trim();
      const row = code
        ? getDb()
            .select({ code: inviteCodes.code })
            .from(inviteCodes)
            .where(and(eq(inviteCodes.code, code), isNull(inviteCodes.usedBy)))
            .get()
        : undefined;
      if (!row) throw new HttpError(403, 'INVALID_INVITE_CODE', '邀请码无效或已被使用');
      inviteCode = row.code;
    }

    // 同 IP 24h ≤ N 号
    const maxPerIp = getSettingInt('MAX_ACCOUNTS_PER_IP_24H', 5);
    const recent =
      getDb()
        .select({ n: sql<number>`count(*)` })
        .from(registrations)
        .where(and(eq(registrations.ip, ip), gt(registrations.createdAt, Date.now() - 24 * 3600_000)))
        .get()?.n ?? 0;
    if (recent >= maxPerIp) {
      throw new HttpError(429, 'TOO_MANY_REGISTRATIONS', '该地址近期注册次数过多');
    }

    // 用户名/邮箱占用（users + 待激活 registrations 双查）
    const usernameTaken =
      getDb().select({ id: users.id }).from(users).where(eq(users.username, username)).get() ??
      getDb().select({ id: registrations.id }).from(registrations).where(eq(registrations.username, username)).get();
    if (usernameTaken) throw new HttpError(409, 'USERNAME_TAKEN', '用户名已被占用');
    const emailTaken =
      getDb().select({ id: users.id }).from(users).where(eq(users.email, email)).get() ??
      getDb().select({ id: registrations.id }).from(registrations).where(eq(registrations.email, email)).get();
    if (emailTaken) throw new HttpError(409, 'EMAIL_TAKEN', '邮箱已被占用');

    // 发送验证码（60s/24h 限发在 issueCode 内）
    const issued = await issueCode('email', email, 'register', ip);

    const id = randomToken(16);
    const now = Date.now();
    getDb()
      .insert(registrations)
      .values({
        id,
        username,
        passwordHash: await hashPassword(password),
        email,
        inviteCode,
        ip,
        createdAt: now,
        expiresAt: now + 24 * 3600_000, // 24h 内完成验证；废弃行按 N 天清理
      })
      .run();

    audit(`anon:${ip}`, ip, 'user.register.start', { username, email: maskEmail(email), invite: inviteCode });
    res.json({
      registrationId: id,
      sentTo: issued.sentTo,
      resendAfterMs: issued.resendAfterMs,
      viaLogFallback: issued.viaLogFallback,
    });
  }),
);

authRouter.post(
  '/auth/register/verify',
  h(async (req, res) => {
    const ip = req.clientIp ?? 'unknown';
    const body = (req.body ?? {}) as { registrationId?: string; code?: string };
    const reg = body.registrationId
      ? getDb().select().from(registrations).where(eq(registrations.id, body.registrationId)).get()
      : undefined;
    if (!reg || reg.expiresAt <= Date.now()) {
      throw new HttpError(404, 'REGISTRATION_NOT_FOUND', '注册会话不存在或已过期，请重新注册');
    }

    const result = verifyCode('email', reg.email ?? '', 'register', String(body.code ?? '').trim());
    if (!result.ok) {
      // 尝试次数限制：≥5 次失败作废整个注册
      getDb()
        .update(registrations)
        .set({ attempts: sql`${registrations.attempts} + 1` })
        .where(eq(registrations.id, reg.id))
        .run();
      if (reg.attempts + 1 >= 5) {
        getDb().delete(registrations).where(eq(registrations.id, reg.id)).run();
        throw new HttpError(400, 'CODE_TOO_MANY_ATTEMPTS', '验证码错误次数过多，请重新注册', { invalidated: true });
      }
      throw new HttpError(400, result.error === 'CODE_MISMATCH' ? 'CODE_MISMATCH' : 'CODE_INVALID', '验证码错误或已过期');
    }

    // 首账号自动 admin（PRD A2）
    const promote = adminCount() === 0;
    const now = Date.now();
    const info = getDb()
      .insert(users)
      .values({
        kind: 'local',
        username: reg.username,
        email: reg.email,
        name: reg.username,
        role: promote ? 'admin' : 'user',
        status: 'active',
        createdAt: now,
      })
      .run();
    const userId = Number(info.lastInsertRowid);
    // 口令哈希直接搬运（注册 start 时已 scrypt，避免二次计算）
    getDb()
      .insert(localCredentials)
      .values({ userId, passwordHash: reg.passwordHash, updatedAt: now })
      .run();

    if (reg.inviteCode) {
      getDb()
        .update(inviteCodes)
        .set({ usedBy: userId, usedAt: now })
        .where(eq(inviteCodes.code, reg.inviteCode))
        .run();
    }
    getDb().delete(registrations).where(eq(registrations.id, reg.id)).run();

    audit(`local:${reg.username}`, ip, 'user.register.done', { userId, promoted: promote });

    createSession(res, { id: userId }, { ip, userAgent: req.headers['user-agent'] });
    const user = loadUserById(userId);
    res.json({
      user: publicUserOf(user),
      authState: 'full',
      mfaRequired: false,
      mustChangePassword: user.mustChangePassword,
    });
  }),
);

// ---------- 登录 / 登出 / me ----------

authRouter.post(
  '/auth/login',
  h(async (req, res) => {
    const ip = req.clientIp ?? 'unknown';
    const body = (req.body ?? {}) as { username?: string; password?: string } & PowBody;

    // 封禁检查
    const ban = isBanned(ip);
    if (ban) {
      throw new HttpError(403, 'IP_BANNED', '该地址已被封禁', {
        action: 'banned',
        bannedUntil: ban.banned_until,
      });
    }

    // 条件 PoW（失败超阈值）
    enforcePow(req, body, false);

    const username = String(body.username ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const subject = `local:${username}`;

    const user = loadUserByUsername(username);
    const hash = user ? getLocalPasswordHash(user.id) : null;
    const ok = await verifyPassword(password, hash);
    if (!user || !ok) {
      if (!user) await dummyVerify(password);
      const fail = recordFailure(ip, subject, 'bad-credentials');
      audit(subject, ip, 'login.fail', { reason: 'bad-credentials', failures: fail.failures });
      throw new HttpError(401, 'BAD_CREDENTIALS', '用户名或密码错误', {
        ...(needsPow(ip) ? { action: 'pow', challenge: issueChallenge(ip) } : {}),
        failures: fail.failures,
        banned: fail.banned,
      });
    }
    if (user.status === 'disabled') {
      audit(subject, ip, 'login.fail', { reason: 'disabled' });
      throw new HttpError(403, 'ACCOUNT_DISABLED', '账号已被禁用');
    }

    recordSuccess(ip, subject);

    // 管理员首次登录：删除一次性凭据文件（F3）
    if (user.role === 'admin' && user.mustChangePassword) {
      disposeCredentialsFile();
    }

    // MFA 状态机：已启用第二因子 → 半登录态（W4 激活验证端点）
    const mfaEnabled = user.mfaEnabled;
    const authState = mfaEnabled ? 'password_ok' : 'full';
    createSession(res, { id: user.id }, { ip, userAgent: req.headers['user-agent'], authState });
    audit(subject, ip, mfaEnabled ? 'login.password_ok' : 'local.login', { userId: user.id });

    res.json({
      user: publicUserOf(user),
      authState,
      mfaRequired: mfaEnabled,
      mustChangePassword: user.mustChangePassword,
    });
  }),
);

// 步升认证：密码通道（无 MFA 的用户用重输密码完成敏感操作前置验证）
authRouter.post(
  '/auth/step-up/password',
  h(async (req, res) => {
    const u = req.user;
    if (!u) throw new HttpError(401, 'UNAUTHENTICATED', '请先登录');
    if (u.authState !== 'full') throw new HttpError(403, 'MFA_REQUIRED', '请先完成多因子认证', { action: 'mfa' });
    const body = (req.body ?? {}) as { password?: string };
    const hash = getLocalPasswordHash(u.id);
    const ok = await verifyPassword(String(body.password ?? ''), hash);
    if (!ok) {
      audit(`${u.kind}:${u.id}`, req.clientIp ?? null, 'auth.stepup.fail', { via: 'password' });
      throw new HttpError(401, 'BAD_CREDENTIALS', '密码错误');
    }
    const until = markStepUp(u.sessionId);
    audit(`${u.kind}:${u.id}`, req.clientIp ?? null, 'auth.stepup', { via: 'password' });
    res.json({ stepUpUntil: until });
  }),
);

// GET 登出：统一页面元素（chrome）用；next 仅允许站内 / 与 /app/ 路径
authRouter.get('/auth/logout', (req, res) => {
  if (req.user) {
    audit(`${req.user.kind}:${req.user.id}`, req.clientIp ?? null, 'logout', { via: 'chrome' });
  }
  destroySession(req, res);
  const next = String((req.query.next as string | undefined) ?? '/');
  const safe = next.startsWith('/app/') || next === '/' || next.startsWith('/?');
  res.redirect(302, safe ? next : '/');
});

authRouter.post(
  '/auth/logout',
  h(async (req, res) => {
    if (req.user) {
      audit(`${req.user.kind}:${req.user.id}`, req.clientIp ?? null, 'logout', {});
    }
    destroySession(req, res);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/auth/me',
  h(async (req, res) => {
    const u = req.user;
    if (!u) {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: '未登录' } });
      return;
    }
    // 半登录态（password_ok）不下发完整资料；挑战页改用 /api/auth/mfa/status
    if (u.authState !== 'full') {
      res.status(403).json({ error: { code: 'MFA_REQUIRED', message: '需要完成多因子认证', action: 'mfa' } });
      return;
    }
    const row = loadUserById(u.id);
    const info: SessionInfo = {
      user: publicUserOf(row),
      authState: u.authState,
      stepUpUntil: u.stepUpUntil,
      mustChangePassword: row.mustChangePassword,
      // MFA 策略（A3）：admin 强制；会员默认强制（M3 接入后按 plan 扩展）
      mustEnrollMfa: row.role === 'admin' && !row.mfaEnabled,
    };
    res.json(info);
  }),
);

// ---------- OIDC 登录（A5；MFA 委托 IdP） ----------

authRouter.get('/auth/oidc/start', h(async (req, res) => {
  const url = await buildLoginRedirect(req);
  res.redirect(302, url);
}));

authRouter.get('/auth/oidc/callback', h(async (req, res) => {
  const ip = req.clientIp ?? 'unknown';
  try {
    const profile = await exchangeCallback(req, req.query as { code?: string; state?: string });
    // 按 subject upsert（统一 users 表，无 (kind,uid) 串号面）
    let row = getDb().select().from(users).where(eq(users.subject, profile.subject)).get();
    const now = Date.now();
    if (!row) {
      const promote = isAdminSubject(profile);
      // 准入策略（OIDC 新账户）：管理员批准 → 创建待批准账号，不建会话
      const policy = getSetting('OIDC_NEW_USER_POLICY') || 'admin_approval';
      if (policy === 'admin_approval' && !promote) {
        const info = getDb()
          .insert(users)
          .values({
            kind: 'oidc',
            subject: profile.subject,
            email: profile.email,
            name: profile.name,
            role: 'user',
            status: 'pending_approval',
            createdAt: now,
          })
          .run();
        audit(`oidc:${profile.subject}`, ip, 'user.oidc.pending_approval', { userId: Number(info.lastInsertRowid) });
        res.redirect(302, '/login?error=oidc_pending');
        return;
      }
      const info = getDb()
        .insert(users)
        .values({
          kind: 'oidc',
          subject: profile.subject,
          email: profile.email,
          name: profile.name,
          role: promote ? 'admin' : 'user',
          createdAt: now,
        })
        .run();
      row = getDb().select().from(users).where(eq(users.id, Number(info.lastInsertRowid))).get();
      // 白名单内的待批准账号：自动激活并提升
      if (promote && row!.status === 'pending_approval') {
        getDb().update(users).set({ role: 'admin', status: 'active' }).where(eq(users.id, row!.id)).run();
        audit(`oidc:${profile.subject}`, ip, 'user.oidc.admin_approved', { userId: row!.id });
      }
      // 默认订阅分组：新 OIDC 账号自动加入（可见性/额度随分组）
      const defaultGroup = getSettingInt('OIDC_DEFAULT_GROUP_ID', 0);
      if (defaultGroup > 0) {
        getDb()
          .insert(userGroupMembers)
          .values({ groupId: defaultGroup, userId: row!.id, createdAt: Date.now() })
          .onConflictDoNothing()
          .run();
      }
      audit(`oidc:${profile.subject}`, ip, 'user.oidc.created', { userId: row!.id, promoted: promote });
    } else {
      getDb()
        .update(users)
        .set({ email: profile.email ?? row.email, name: profile.name || row.name, lastLoginAt: now, lastIp: ip })
        .where(eq(users.id, row.id))
        .run();
    }
    if (row!.status === 'disabled') {
      res.redirect(302, '/login?error=account_disabled');
      return;
    }
    recordSuccess(ip, `oidc:${profile.subject}`);
    createSession(res, { id: row!.id }, { ip, userAgent: req.headers['user-agent'], authState: 'full' });
    audit(`oidc:${profile.subject}`, ip, 'oidc.login', { userId: row!.id });
    res.redirect(302, '/');
  } catch (err) {
    if (err instanceof HttpError) {
      res.redirect(302, `/login?error=${encodeURIComponent(err.code)}`);
      return;
    }
    console.error('[oidc] callback failed:', err);
    res.redirect(302, '/login?error=oidc_failed');
  }
}));

// ---------- 找回密码 ----------

authRouter.post(
  '/auth/forgot/start',
  h(async (req, res) => {
    const ip = req.clientIp ?? 'unknown';
    const body = (req.body ?? {}) as { email?: string } & PowBody;
    enforcePow(req, body, true);
    await enforceTurnstile(req, body);

    const email = String(body.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'INVALID_EMAIL', '邮箱格式不正确');

    // 无论是否存在都返回 ok（防枚举）；存在才真正发码
    const user = getDb().select({ id: users.id }).from(users).where(eq(users.email, email)).get();
    if (user) {
      await issueCode('email', email, 'reset', ip);
    }
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/auth/forgot/verify',
  h(async (req, res) => {
    const ip = req.clientIp ?? 'unknown';
    const body = (req.body ?? {}) as { email?: string; code?: string; newPassword?: string };
    const email = String(body.email ?? '').trim().toLowerCase();
    const newPassword = String(body.newPassword ?? '');
    if (newPassword.length < 8 || newPassword.length > 128) {
      throw new HttpError(400, 'INVALID_PASSWORD', '密码长度需 8-128 位');
    }

    const user = getDb().select().from(users).where(and(eq(users.email, email), eq(users.kind, 'local'))).get();
    // 用户不存在时也走一次码校验（时序一致）；实际不会有有效码
    const result = verifyCode('email', email, 'reset', String(body.code ?? '').trim());
    if (!user || !result.ok) {
      throw new HttpError(400, result.ok ? 'RESET_FAILED' : result.error, '重置失败：验证码错误或已过期');
    }

    await writeLocalCredentials(user.id, newPassword);
    getDb().update(users).set({ mustChangePassword: false }).where(eq(users.id, user.id)).run();
    // 全端踢下线
    getDb().delete(sessions).where(eq(sessions.userId, user.id)).run();
    audit(`local:${user.username}`, ip, 'local.password.reset', { userId: user.id });
    res.json({ ok: true });
  }),
);

// ---------- 改密（已登录；mustChangePassword 强制流用） ----------

authRouter.post(
  '/auth/change-password',
  h(async (req, res) => {
    const u = req.user;
    if (!u) throw new HttpError(401, 'UNAUTHENTICATED', '请先登录');
    const body = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
    const newPassword = String(body.newPassword ?? '');
    if (newPassword.length < 8 || newPassword.length > 128) {
      throw new HttpError(400, 'INVALID_PASSWORD', '密码长度需 8-128 位');
    }
    const hash = getLocalPasswordHash(u.id);
    const ok = await verifyPassword(String(body.currentPassword ?? ''), hash);
    if (!ok) {
      audit(`${u.kind}:${u.id}`, req.clientIp ?? null, 'local.password.change.fail', {});
      throw new HttpError(401, 'BAD_CREDENTIALS', '当前密码错误');
    }
    await writeLocalCredentials(u.id, newPassword);
    getDb().update(users).set({ mustChangePassword: false }).where(eq(users.id, u.id)).run();
    // 其他会话全部踢下线，保留当前会话
    getDb()
      .delete(sessions)
      .where(and(eq(sessions.userId, u.id), ne(sessions.tokenHash, u.sessionId)))
      .run();
    audit(`${u.kind}:${u.id}`, req.clientIp ?? null, 'local.password.change', {});
    res.json({ ok: true });
  }),
);

function registrationMode(): 'closed' | 'open' | 'invite' {
  const m = getSetting('REGISTRATION_MODE') ?? 'closed';
  return m === 'open' || m === 'invite' ? m : 'closed';
}

// 废弃注册（未完成验证）N 天清理（A2），挂进统一清理循环
registerPurgeTask((now) => {
  const ttlDays = getSettingInt('REGISTRATION_PENDING_TTL_DAYS', 7);
  getDb()
    .delete(registrations)
    .where(lt(registrations.createdAt, now - ttlDays * 86_400_000))
    .run();
});
