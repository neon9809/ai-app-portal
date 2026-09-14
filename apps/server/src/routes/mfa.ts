/**
 * MFA 路由（A3）：TOTP 绑定/确认/解绑、恢复码、Passkey 绑定与认证、
 * 登录状态机验证端点（password_ok → full）、步升认证。
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { SessionInfo } from '@aap/shared';
import { getDb } from '../db/index.js';
import { sessions, users } from '../db/schema.js';
import type { SessionUser } from '../types.js';
import { HttpError, h } from '../lib/httpError.js';
import { requireAuth, requireStepUp } from '../lib/auth.js';
import { createSession, markStepUp, stepUpTtlSec, upgradeSessionToFull } from '../lib/session.js';
import { publicUserOf } from './shared.js';
import {
  confirmTotp,
  disableTotp,
  enrollTotp,
  generateRecoveryCodes,
  remainingRecoveryCodes,
  totpConfirmed,
  verifyTotpForLogin,
} from '../lib/mfa.js';
import {
  deletePasskey,
  listPasskeys,
  passkeyAuthOptions,
  passkeyAuthVerify,
  passkeyRegisterOptions,
  passkeyRegisterVerify,
} from '../lib/passkey.js';
import { audit } from '../lib/audit.js';
import { getSetting } from '../lib/settings.js';

export const mfaRouter = Router();

/** 半登录态（password_ok）守卫：MFA 验证端点专用 */
function requireMfaPending(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } });
    return;
  }
  next();
}

function requireTotpBound(userId: number): void {
  if (!totpConfirmed(userId)) throw new HttpError(400, 'TOTP_NOT_ENROLLED', 'TOTP 未绑定');
}

// ---------- TOTP 错猜节流 ----------
// 6 位码 10^6 空间，无节流时持密码会话可在线穷举绕过第二因子：
// 同一会话 10 分钟窗口内错猜 ≥5 次 → 会话作废，须重新走完整登录。

const TOTP_FAIL_LIMIT = 5;
const TOTP_FAIL_WINDOW_MS = 10 * 60_000;
const totpFails = new Map<string, { n: number; first: number }>();

function recordTotpFail(sessionId: string): number {
  const now = Date.now();
  if (totpFails.size > 10_000) {
    for (const [k, v] of totpFails) if (now - v.first > TOTP_FAIL_WINDOW_MS) totpFails.delete(k);
  }
  const rec = totpFails.get(sessionId);
  if (!rec || now - rec.first > TOTP_FAIL_WINDOW_MS) {
    totpFails.set(sessionId, { n: 1, first: now });
    return 1;
  }
  rec.n += 1;
  return rec.n;
}

async function verifyTotpGuarded(req: Request, u: SessionUser, token: string): Promise<void> {
  try {
    await verifyTotpForLogin(u.id, token, req.clientIp ?? null);
  } catch (err) {
    const fails = recordTotpFail(u.sessionId);
    if (fails >= TOTP_FAIL_LIMIT) {
      getDb().delete(sessions).where(eq(sessions.tokenHash, u.sessionId)).run();
      audit(`user:${u.id}`, req.clientIp ?? null, 'mfa.totp.session_invalidated', { fails });
      throw new HttpError(400, 'MFA_TOO_MANY_ATTEMPTS', '验证码错误次数过多，会话已作废，请重新登录', { relogin: true });
    }
    throw err;
  }
  totpFails.delete(u.sessionId);
}

function loadUserRow(userId: number) {
  const row = getDb().select().from(users).where(eq(users.id, userId)).get();
  if (!row) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
  return row;
}

// ---------- TOTP 绑定管理（完整登录态 + 步升：防被劫持会话静默绑定新因子） ----------

mfaRouter.post(
  '/auth/mfa/totp/enroll',
  requireStepUp,
  h(async (req, res) => {
    const u = req.user!;
    const { secret, otpauthUri } = enrollTotp(u.id, getSetting('SITE_NAME') || 'AI应用门户', u.username ?? u.name);
    res.json({ secret, otpauthUri });
  }),
);

mfaRouter.post(
  '/auth/mfa/totp/confirm',
  requireStepUp,
  h(async (req, res) => {
    const u = req.user!;
    const { token } = (req.body ?? {}) as { token?: string };
    const codes = await confirmTotp(u.id, String(token ?? ''));
    res.json({ recoveryCodes: codes, recoveryRemaining: codes.length });
  }),
);

mfaRouter.post(
  '/auth/mfa/totp/disable',
  requireStepUp,
  h(async (req, res) => {
    const u = req.user!;
    disableTotp(u.id, u.role === 'admin');
    res.json({ ok: true });
  }),
);

mfaRouter.post(
  '/auth/mfa/recovery/regenerate',
  requireStepUp,
  h(async (req, res) => {
    const u = req.user!;
    requireTotpBound(u.id);
    const codes = generateRecoveryCodes(u.id);
    audit(`user:${u.id}`, req.clientIp ?? null, 'mfa.recovery.regenerated', {});
    res.json({ recoveryCodes: codes });
  }),
);

// ---------- MFA 状态（半登录态也可读——前端挑战页需要） ----------

mfaRouter.get(
  '/auth/mfa/status',
  requireMfaPending,
  h(async (req, res) => {
    const u = req.user!;
    res.json({
      totpConfirmed: totpConfirmed(u.id),
      passkeys: listPasskeys(u.id),
      recoveryRemaining: remainingRecoveryCodes(u.id),
    });
  }),
);

// ---------- 登录验证端点（password_ok → full） ----------

mfaRouter.post(
  '/auth/mfa/login/totp',
  requireMfaPending,
  h(async (req, res) => {
    const u = req.user!;
    if (u.authState !== 'password_ok') throw new HttpError(400, 'INVALID_STATE', '当前会话无需 MFA 验证');
    const { token } = (req.body ?? {}) as { token?: string };
    await verifyTotpGuarded(req, u, String(token ?? ''));
    upgradeSessionToFull(u.sessionId);
    u.authState = 'full';
    const row = loadUserRow(u.id);
    const info: SessionInfo = {
      user: publicUserOf(row),
      authState: 'full',
      stepUpUntil: null,
      mustChangePassword: row.mustChangePassword,
      mustEnrollMfa: false,
    };
    res.json(info);
  }),
);

mfaRouter.post(
  '/auth/mfa/login/passkey/options',
  requireMfaPending,
  h(async (req, res) => {
    const u = req.user;
    // 半登录态：限定该用户的凭据；理论上也可能匿名进入做无密码登录（同端点兼容）
    const result = await passkeyAuthOptions(req, u ? u.id : null);
    res.json(result);
  }),
);

mfaRouter.post(
  '/auth/mfa/login/passkey/verify',
  requireMfaPending,
  h(async (req, res) => {
    const { requestId, response } = (req.body ?? {}) as { requestId?: string; response?: AuthenticationResponseJSON };
    const result = await passkeyAuthVerify(req, String(requestId ?? ''), response!);
    const u2 = req.user!;
    if (u2.authState === 'password_ok' && u2.id === result.userId) {
      // 二次因子：升级当前会话
      upgradeSessionToFull(u2.sessionId);
      u2.authState = 'full';
      const row = loadUserRow(u2.id);
      const info: SessionInfo & { mfaRequired: boolean } = {
        user: publicUserOf(row),
        authState: 'full',
        stepUpUntil: null,
        mustChangePassword: row.mustChangePassword,
        mustEnrollMfa: false,
        mfaRequired: false,
      };
      res.json(info);
      return;
    }
    // 匿名（无密码主登录）或用户不匹配 → 建新会话（旧半登录态作废）
    throw new HttpError(400, 'INVALID_STATE', '当前会话不适用 Passkey 登录，请使用密码登录');
  }),
);

// ---------- Passkey 绑定管理（完整登录态） ----------

mfaRouter.post(
  '/auth/mfa/passkey/register-options',
  requireStepUp,
  h(async (req, res) => {
    const u = req.user!;
    const options = await passkeyRegisterOptions(req, u.id, u.username ?? u.name);
    res.json(options);
  }),
);

mfaRouter.post(
  '/auth/mfa/passkey/register-verify',
  requireStepUp,
  h(async (req, res) => {
    const u = req.user!;
    const { nickname, response } = (req.body ?? {}) as { nickname?: string; response?: RegistrationResponseJSON };
    const passkey = await passkeyRegisterVerify(req, u.id, String(nickname ?? ''), response!);
    res.json({ passkey });
  }),
);

mfaRouter.get(
  '/auth/mfa/passkeys',
  requireAuth,
  h(async (req, res) => {
    res.json({ passkeys: listPasskeys(req.user!.id) });
  }),
);

mfaRouter.delete(
  '/auth/mfa/passkeys/:id',
  requireStepUp,
  h(async (req, res) => {
    const u = req.user!;
    deletePasskey(u.id, String(req.params.id ?? ''), u.role === 'admin', totpConfirmed(u.id));
    res.json({ ok: true });
  }),
);

// ---------- 无密码主登录（匿名 Passkey；A3 双角色之二） ----------

mfaRouter.post(
  '/auth/login/passkey/options',
  h(async (req, res) => {
    const result = await passkeyAuthOptions(req, null);
    res.json(result);
  }),
);

mfaRouter.post(
  '/auth/login/passkey/verify',
  h(async (req, res) => {
    const { requestId, response } = (req.body ?? {}) as {
      requestId?: string;
      response?: AuthenticationResponseJSON;
    };
    const result = await passkeyAuthVerify(req, String(requestId ?? ''), response!);
    const row = getDb().select().from(users).where(eq(users.id, result.userId)).get();
    if (!row || row.status !== 'active') throw new HttpError(403, 'ACCOUNT_DISABLED', '账号不可用');
    const ip = req.clientIp ?? null;
    createSession(res, { id: row.id }, { ip, userAgent: req.headers['user-agent'], authState: 'full', grantStepUp: true });
    audit(`user:${row.id}`, ip, 'login.passkey', { credentialId: result.credentialId });
    const info: SessionInfo & { mfaRequired: boolean } = {
      user: publicUserOf(row),
      authState: 'full',
      stepUpUntil: null,
      mustChangePassword: row.mustChangePassword,
      mustEnrollMfa: false,
      mfaRequired: false,
    };
    res.json(info);
  }),
);

// ---------- 步升认证（敏感操作前重验一次因子） ----------

mfaRouter.post(
  '/auth/step-up/totp',
  requireAuth,
  h(async (req, res) => {
    const u = req.user!;
    requireTotpBound(u.id);
    const { token } = (req.body ?? {}) as { token?: string };
    await verifyTotpGuarded(req, u, String(token ?? ''));
    const until = markStepUp(u.sessionId);
    audit(`user:${u.id}`, req.clientIp ?? null, 'auth.stepup', { via: 'totp' });
    res.json({ stepUpUntil: until, ttlSec: stepUpTtlSec() });
  }),
);

mfaRouter.post(
  '/auth/step-up/passkey/options',
  requireAuth,
  h(async (req, res) => {
    const result = await passkeyAuthOptions(req, req.user!.id);
    res.json(result);
  }),
);

mfaRouter.post(
  '/auth/step-up/passkey/verify',
  requireAuth,
  h(async (req, res) => {
    const u = req.user!;
    const { requestId, response } = (req.body ?? {}) as { requestId?: string; response?: AuthenticationResponseJSON };
    const result = await passkeyAuthVerify(req, String(requestId ?? ''), response!);
    if (result.userId !== u.id) throw new HttpError(403, 'FORBIDDEN', '凭据不属于当前用户');
    const until = markStepUp(u.sessionId);
    audit(`user:${u.id}`, req.clientIp ?? null, 'auth.stepup', { via: 'passkey' });
    res.json({ stepUpUntil: until, ttlSec: stepUpTtlSec() });
  }),
);
