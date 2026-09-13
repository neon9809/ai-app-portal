/**
 * 用户中心（A4）：个人资料、邮箱换绑（验证码通道 + 步升认证）、
 * 登录会话列表与踢下线、账单占位（M3）、注销（7 天冷静期可撤回）。
 */
import { Router } from 'express';
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { sessions, users } from '../db/schema.js';
import { HttpError, h } from '../lib/httpError.js';
import { requireAuth, requireStepUp } from '../lib/auth.js';
import { publicUserOf } from './shared.js';
import { registerPurgeTask } from '../lib/audit.js';
import { getSetting, getSettingInt } from '../lib/settings.js';
import { issueCode, verifyCode } from '../lib/verification.js';
import { audit } from '../lib/audit.js';

export const userRouter = Router();

userRouter.use('/user', requireAuth);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_AVATAR_BYTES = 100 * 1024;

userRouter.get(
  '/user/profile',
  h(async (req, res) => {
    const row = getDb().select().from(users).where(eq(users.id, req.user!.id)).get();
    if (!row) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    res.json({ user: publicUserOf(row) });
  }),
);

userRouter.patch(
  '/user/profile',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { name?: string; avatar?: string | null };
    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.name !== undefined) {
      const name = body.name.trim().slice(0, 64);
      if (!name) throw new HttpError(400, 'INVALID_NAME', '昵称不能为空');
      patch.name = name;
    }
    if (body.avatar !== undefined) {
      if (body.avatar === null || body.avatar === '') {
        patch.avatar = null;
      } else {
        // 仅接受 data URI（头像内联存储，限制大小防滥用）
        if (!body.avatar.startsWith('data:image/')) throw new HttpError(400, 'INVALID_AVATAR', '头像必须是图片');
        if (body.avatar.length > MAX_AVATAR_BYTES) throw new HttpError(400, 'AVATAR_TOO_LARGE', '头像图片过大（≤100KB）');
        patch.avatar = body.avatar;
      }
    }
    getDb().update(users).set(patch).where(eq(users.id, req.user!.id)).run();
    audit(`user:${req.user!.id}`, req.clientIp ?? null, 'user.profile.update', { keys: Object.keys(patch) });
    const row = getDb().select().from(users).where(eq(users.id, req.user!.id)).get();
    res.json({ user: publicUserOf(row!) });
  }),
);

// ---------- 邮箱换绑（验证码发到新邮箱；敏感操作需步升认证） ----------

userRouter.post(
  '/user/email/change/start',
  requireStepUp,
  h(async (req, res) => {
    const body = (req.body ?? {}) as { newEmail?: string; powToken?: string };
    const newEmail = String(body.newEmail ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(newEmail)) throw new HttpError(400, 'INVALID_EMAIL', '邮箱格式不正确');
    const taken = getDb().select({ id: users.id }).from(users).where(eq(users.email, newEmail)).get();
    if (taken && taken.id !== req.user!.id) throw new HttpError(409, 'EMAIL_TAKEN', '邮箱已被其他账号占用');
    const issued = await issueCode('email', newEmail, 'bind', req.clientIp ?? null);
    res.json({ sentTo: issued.sentTo, resendAfterMs: issued.resendAfterMs, viaLogFallback: issued.viaLogFallback });
  }),
);

userRouter.post(
  '/user/email/change/verify',
  requireStepUp,
  h(async (req, res) => {
    const body = (req.body ?? {}) as { newEmail?: string; code?: string };
    const newEmail = String(body.newEmail ?? '').trim().toLowerCase();
    const result = verifyCode('email', newEmail, 'bind', String(body.code ?? '').trim());
    if (!result.ok) throw new HttpError(400, result.error === 'CODE_MISMATCH' ? 'CODE_MISMATCH' : 'CODE_INVALID', '验证码错误或已过期');
    const taken = getDb().select({ id: users.id }).from(users).where(eq(users.email, newEmail)).get();
    if (taken && taken.id !== req.user!.id) throw new HttpError(409, 'EMAIL_TAKEN', '邮箱已被其他账号占用');
    getDb().update(users).set({ email: newEmail }).where(eq(users.id, req.user!.id)).run();
    audit(`user:${req.user!.id}`, req.clientIp ?? null, 'user.email.changed', {});
    res.json({ ok: true });
  }),
);

// ---------- 登录会话列表 / 踢下线 ----------

userRouter.get(
  '/user/sessions',
  h(async (req, res) => {
    const uid = req.user!.id;
    const rows = getDb()
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, uid), gt(sessions.expiresAt, Date.now())))
      .orderBy(sql`last_seen_at DESC`)
      .all();
    res.json({
      sessions: rows.map((s) => ({
        id: s.tokenHash.slice(0, 12),
        current: s.tokenHash === req.user!.sessionId,
        ip: s.ip,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
      })),
    });
  }),
);

userRouter.delete(
  '/user/sessions/:id',
  h(async (req, res) => {
    const uid = req.user!.id;
    const prefix = String(req.params.id ?? '');
    const rows = getDb()
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, uid), gt(sessions.expiresAt, Date.now())))
      .all();
    const target = rows.find((r) => r.tokenHash.startsWith(prefix));
    if (!target) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在或已过期');
    if (target.tokenHash === req.user!.sessionId) {
      throw new HttpError(400, 'CURRENT_SESSION', '不能踢除当前会话（请用退出登录）');
    }
    getDb().delete(sessions).where(eq(sessions.id, target.id)).run();
    audit(`user:${uid}`, req.clientIp ?? null, 'user.session.revoked', { sessionId: prefix });
    res.json({ ok: true });
  }),
);

// ---------- 账单（M3 占位） ----------

userRouter.get(
  '/user/billing',
  h(async (req, res) => {
    const row = getDb().select({ plan: users.plan }).from(users).where(eq(users.id, req.user!.id)).get();
    res.json({
      plan: row?.plan ?? 'free',
      membershipUntil: null,
      tokenBalance: null,
      note: '会员与 token 充值在 M3（计费闭环）上线后开放',
    });
  }),
);

// ---------- 注销（7 天冷静期可撤回 → 数据匿名化） ----------

userRouter.post(
  '/user/delete/request',
  requireStepUp,
  h(async (req, res) => {
    const uid = req.user!.id;
    const now = Date.now();
    getDb()
      .update(users)
      .set({ status: 'deletion_pending', deletionRequestedAt: now })
      .where(eq(users.id, uid))
      .run();
    // 踢除其他会话，保留当前（供撤回）
    getDb()
      .delete(sessions)
      .where(and(eq(sessions.userId, uid), ne(sessions.tokenHash, req.user!.sessionId)))
      .run();
    audit(`user:${uid}`, req.clientIp ?? null, 'user.delete.requested', {
      cooldownDays: getSettingInt('DELETION_COOLDOWN_DAYS', 7),
    });
    res.json({ ok: true });
  }),
);

userRouter.post(
  '/user/delete/cancel',
  h(async (req, res) => {
    const uid = req.user!.id;
    const row = getDb().select().from(users).where(eq(users.id, uid)).get();
    if (row?.status === 'deletion_pending') {
      getDb().update(users).set({ status: 'active', deletionRequestedAt: null }).where(eq(users.id, uid)).run();
      audit(`user:${uid}`, req.clientIp ?? null, 'user.delete.cancelled', {});
    }
    res.json({ ok: true });
  }),
);

/** 冷静期到期 → 匿名化：删除用户行（级联会话/凭据/MFA），审计保留脱敏记录 */
registerPurgeTask((now) => {
  const cooldownMs = getSettingInt('DELETION_COOLDOWN_DAYS', 7) * 86_400_000;
  const due = getDb()
    .select()
    .from(users)
    .where(and(eq(users.status, 'deletion_pending'), sql`deletion_requested_at < ${now - cooldownMs}`))
    .all();
  for (const u of due) {
    getDb().delete(users).where(eq(users.id, u.id)).run();
    audit(`deleted:${u.id}`, null, 'user.deleted.anonymized', {
      // 脱敏保留：仅留 ID 与时间，不留用户名/邮箱
      registeredAt: u.createdAt,
      deletedAt: now,
    });
  }
});

void getSetting;
