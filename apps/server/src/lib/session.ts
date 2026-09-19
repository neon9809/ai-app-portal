/**
 * 服务端会话——移植自参考实现 lib/session.js，适配统一 users 表：
 *  - token 随机 32B（base64url），DB 只存 SHA-256；
 *  - cookie httpOnly + sameSite=lax；Secure 在 HTTPS 启用后由 tls 模块置位（W6）；
 *  - 登录状态机：auth_state = password_ok → mfa_pending → full（W4 激活）；
 *  - loadSessionByToken 同时服务 Express 中间件与裸 req（WS upgrade，W5）。
 */
import type { Request, RequestHandler, Response } from 'express';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { AuthState } from '@aap/shared';
import { config } from '../config/index.js';
import { getSqlite } from '../db/index.js';
import { sha256Hex } from './passwords.js';
import { getSettingInt } from './settings.js';
import type { SessionUser } from '../types.js';

export const hashToken = sha256Hex;

/** 步升认证有效期（秒）：重验一次因子后 5 分钟内免重验 */
export function stepUpTtlSec(): number {
  return getSettingInt('MFA_STEPUP_TTL', 300);
}

// HTTPS 状态由 tls 模块（W6）在证书启用/移除时调用
let secureCookieOverride: boolean | null = null;
export function setSecureCookie(v: boolean | null): void {
  secureCookieOverride = v;
}

export function sessionTtlSec(): number {
  return getSettingInt('SESSION_TTL', 86400);
}

interface CookieOpts {
  httpOnly: true;
  sameSite: 'lax';
  maxAge: number;
  path: '/';
  secure?: true;
}

function cookieOptions(): CookieOpts {
  const opts: CookieOpts = {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: sessionTtlSec() * 1000,
    path: '/',
  };
  if (secureCookieOverride) opts.secure = true;
  return opts;
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

interface SessionJoinRow {
  token_hash: string;
  auth_state: string;
  step_up_until: number | null;
  expires_at: number;
  last_seen_at: number;
  u_id: number;
  kind: string;
  username: string | null;
  email: string | null;
  phone: string | null;
  name: string;
  role: string;
  status: string;
  plan: string;
  mfa_enabled: number;
  must_change_password: number;
}

let joinStmt: Database.Statement | null = null;

/**
 * 按会话 token（明文）装载用户；过期/用户禁用即删会话返回 null。
 * 独立成函数以便 WS upgrade（裸 req）复用。
 */
export function loadSessionByToken(token: string | undefined | null): SessionUser | null {
  if (!token) return null;
  const s = getSqlite();
  if (!joinStmt) {
    joinStmt = s.prepare(`
      SELECT s.token_hash, s.auth_state, s.step_up_until, s.expires_at, s.last_seen_at,
             u.id AS u_id, u.kind, u.username, u.email, u.phone, u.name, u.role, u.status,
             u.plan, u.mfa_enabled, u.must_change_password
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `);
  }
  const tokenHash = hashToken(token);
  const row = joinStmt.get(tokenHash) as SessionJoinRow | undefined;
  if (!row) return null;

  const del = (): void => {
    s.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  };

  if (row.expires_at <= Date.now()) {
    del();
    return null;
  }
  // 用户被禁用/待批准：会话即刻作废（deletion_pending 仍可登录以便撤回注销）
  if (row.status === 'disabled' || row.status === 'pending_approval') {
    del();
    return null;
  }

  // lastSeenAt 节流刷新（≥60s 才写，避免每请求写放大）
  if (Date.now() - row.last_seen_at > 60_000) {
    s.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(Date.now(), tokenHash);
  }

  return {
    id: row.u_id,
    kind: row.kind === 'oidc' ? 'oidc' : 'local',
    subject: row.kind === 'oidc' ? `oidc:${row.email ?? row.u_id}` : `local:${row.username ?? row.u_id}`,
    username: row.username,
    email: row.email,
    phone: row.phone,
    name: row.name || row.username || `用户${row.u_id}`,
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.status,
    plan: row.plan === 'member' ? 'member' : 'free',
    sessionId: row.token_hash,
    authState: (row.auth_state as AuthState) || 'full',
    stepUpUntil: row.step_up_until ?? null,
    mfaEnabled: row.mfa_enabled === 1,
    mustChangePassword: row.must_change_password === 1,
  };
}

/** 创建会话并种 cookie；authState 供 MFA 状态机（W4）。
 *  grantStepUp：登录即授予步升窗口——密码/Passkey/邮箱码本身就是刚验证过的
 *  因子，强制绑 MFA（F3）因此可在登录后立即进行；窗口过期后的敏感操作仍需
 *  重验因子（防被劫持会话静默绑定新 MFA，渗透测试 P2-9）。 */
export function createSession(
  res: Response,
  user: { id: number },
  opts: { ip?: string | null; userAgent?: string | null; authState?: AuthState; ttlSec?: number; grantStepUp?: boolean },
): string {
  const token = generateToken();
  const now = Date.now();
  const ttl = opts.ttlSec ?? sessionTtlSec();
  const expiresAt = now + ttl * 1000;
  const stepUpUntil = opts.grantStepUp ? now + stepUpTtlSec() * 1000 : null;
  const s = getSqlite();
  s.prepare(
    `INSERT INTO sessions(token_hash, user_id, auth_state, step_up_until, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashToken(token),
    user.id,
    opts.authState ?? 'full',
    stepUpUntil,
    now,
    now,
    expiresAt,
    opts.ip ?? null,
    (opts.userAgent ?? '').slice(0, 255),
  );
  s.prepare('UPDATE users SET last_login_at = ?, last_ip = ? WHERE id = ?').run(now, opts.ip ?? null, user.id);
  res.cookie(config.sessionCookieName, token, cookieOptions());
  return token;
}

/** 登出 / 踢下线共用：按 token 哈希删行 */
export function destroySessionByToken(token: string | undefined | null): void {
  if (!token) return;
  getSqlite().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

/** 登录状态机推进：password_ok → full（MFA 验证通过） */
export function upgradeSessionToFull(tokenHash: string): void {
  getSqlite()
    .prepare("UPDATE sessions SET auth_state = 'full' WHERE token_hash = ?")
    .run(tokenHash);
}

/** 敏感操作步升认证：重验一次因子后 5 分钟内免重验（A3） */
export function markStepUp(tokenHash: string): number {
  const ttl = getSettingInt('MFA_STEPUP_TTL', 300);
  const until = Date.now() + ttl * 1000;
  getSqlite().prepare('UPDATE sessions SET step_up_until = ? WHERE token_hash = ?').run(until, tokenHash);
  return until;
}

export function destroySession(req: Request, res: Response): void {
  destroySessionByToken(req.cookies?.[config.sessionCookieName]);
  res.clearCookie(config.sessionCookieName, { path: '/' });
}

/** Express 中间件：装载 req.user（未登录保持 undefined） */
export const sessionMiddleware: RequestHandler = (req, _res, next) => {
  const token = req.cookies?.[config.sessionCookieName];
  req.user = loadSessionByToken(token);
  next();
};

// ---------- 强制流程门禁（F3/A3：强制改密 / admin 强制绑 MFA） ----------

/** admin 强制绑 MFA 判定：仅本账（local）用户。
 *  OIDC 账号 MFA 委托 IdP（ADR），其 mfaEnabled 默认 false，
 *  纳入判定会把 OIDC 管理员锁死在绑定页（终审 P1-6c），故排除。 */
export function mustEnrollMfaFor(u: { kind: string; role: string; mfaEnabled: boolean }): boolean {
  return u.kind === 'local' && u.role === 'admin' && !u.mfaEnabled;
}

/** 门禁白名单：强制流程自身所需端点 + 状态读取。
 *  匿名可读端点（portal bootstrap/品牌等）不要求登录，但浏览器带会话 cookie
 *  访问时同样放行，否则强制流程页面连品牌信息都拿不到。 */
const FORCE_GATE_ALLOW: RegExp[] = [
  /^\/api\/auth\/me$/,
  /^\/api\/auth\/logout$/,
  /^\/api\/auth\/change-password$/,
  /^\/api\/auth\/mfa(\/|$)/,
  /^\/api\/auth\/step-up(\/|$)/,
  /^\/api\/portal\/bootstrap$/,
];

/**
 * 强制流程门禁：mustChangePassword 或（local admin 且未绑 MFA）的会话，
 * 除白名单端点外一律 403（契约 FORCE_CHANGE_PASSWORD / FORCE_ENROLL_MFA）。
 * 挂在 /api 中间件链（sessionMiddleware 之后、业务路由之前）；req.user 的
 * mustChangePassword/mfaEnabled/role 由 loadSessionByToken 装载。
 */
export const forceFlowGate: RequestHandler = (req, res, next) => {
  const u = req.user;
  if (!u) {
    next();
    return;
  }
  const mustEnroll = mustEnrollMfaFor(u);
  if (!u.mustChangePassword && !mustEnroll) {
    next();
    return;
  }
  const p = (req.originalUrl ?? req.url).split('?')[0]!;
  if (FORCE_GATE_ALLOW.some((re) => re.test(p))) {
    next();
    return;
  }
  if (u.mustChangePassword) {
    res.status(403).json({
      error: { code: 'FORCE_CHANGE_PASSWORD', message: '请先修改密码后再继续操作', action: 'change-password' },
    });
    return;
  }
  res.status(403).json({
    error: { code: 'FORCE_ENROLL_MFA', message: '管理员账号须先绑定多因子认证', action: 'mfa' },
  });
};
