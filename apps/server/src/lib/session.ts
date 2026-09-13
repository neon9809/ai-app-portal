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
             u.id AS u_id, u.kind, u.username, u.email, u.phone, u.name, u.role, u.status
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
  // 用户被禁用：会话即刻作废（deletion_pending 仍可登录以便撤回注销）
  if (row.status === 'disabled') {
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
    sessionId: row.token_hash,
    authState: (row.auth_state as AuthState) || 'full',
    stepUpUntil: row.step_up_until ?? null,
  };
}

/** 创建会话并种 cookie；authState 供 MFA 状态机（W4） */
export function createSession(
  res: Response,
  user: { id: number },
  opts: { ip?: string | null; userAgent?: string | null; authState?: AuthState; ttlSec?: number },
): string {
  const token = generateToken();
  const now = Date.now();
  const ttl = opts.ttlSec ?? sessionTtlSec();
  const expiresAt = now + ttl * 1000;
  const s = getSqlite();
  s.prepare(
    `INSERT INTO sessions(token_hash, user_id, auth_state, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashToken(token),
    user.id,
    opts.authState ?? 'full',
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
