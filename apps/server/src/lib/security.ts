/**
 * 来源 IP、登录失败计数、IP 自动封禁（累犯时长倍增）、PoW token
 * ——移植自参考实现 lib/security.js，剥离单位指纹。
 * 关键语义：
 *  - getClientIp 依赖 express 的 trust proxy 设置：无前置代理置 false，
 *    防伪造 XFF 绕过封禁；有前置代理置 1 只信第一跳。
 *  - 封禁时长 = base * multiplier^repeat（累犯翻倍），上限 max。
 */
import type { Request } from 'express';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { getSqlite } from '../db/index.js';
import { getSettingInt, getSettingBool } from './settings.js';
import { audit } from './audit.js';

/** 提取客户端真实 IP（::ffff: 前缀剥离） */
export function getClientIp(req: Request): string {
  return ((req.ip as string | undefined) || req.socket?.remoteAddress || '')
    .replace(/^::ffff:/, '') || 'unknown';
}

// ---- 惰性预编译语句（等 initDb 完成后再 prepare） ----
interface Stmts {
  countFailures: Database.Statement;
  countAccountFailures: Database.Statement;
  insertAttempt: Database.Statement;
  getBan: Database.Statement;
  upsertBan: Database.Statement;
  deleteExpiredBan: Database.Statement;
  insertPowToken: Database.Statement;
  getPow: Database.Statement;
  delPow: Database.Statement;
}

let stmts: Stmts | null = null;

function S(): Stmts {
  if (!stmts) {
    const s = getSqlite();
    stmts = {
      countFailures: s.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND success = 0 AND created_at > ?'),
      countAccountFailures: s.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE user_key = ? AND success = 0 AND created_at > ?'),
      insertAttempt: s.prepare('INSERT INTO login_attempts(ip, user_key, success, reason, created_at) VALUES (?, ?, ?, ?, ?)'),
      getBan: s.prepare('SELECT * FROM ip_bans WHERE ip = ?'),
      upsertBan: s.prepare(
        `INSERT INTO ip_bans(ip, banned_until, repeat_count, created_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(ip) DO UPDATE SET banned_until = excluded.banned_until, repeat_count = ip_bans.repeat_count + 1`,
      ),
      deleteExpiredBan: s.prepare('DELETE FROM ip_bans WHERE ip = ? AND banned_until <= ?'),
      insertPowToken: s.prepare('INSERT INTO pow_tokens(token, ip, created_at, expires_at) VALUES (?, ?, ?, ?)'),
      getPow: s.prepare('SELECT * FROM pow_tokens WHERE token = ?'),
      delPow: s.prepare('DELETE FROM pow_tokens WHERE token = ?'),
    };
  }
  return stmts;
}

interface BanRow {
  ip: string;
  banned_until: number;
  repeat_count: number;
  created_at: number;
}

export function failuresInWindow(ip: string): number {
  const window = getSettingInt('LOGIN_FAIL_WINDOW', 600);
  const row = S().countFailures.get(ip, Date.now() - window * 1000) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** 账号维度失败计数（login_attempts.user_key）：IP 维度对分布式撞库无效，
 *  同一账号跨 IP 穷举也要进 PoW/封禁语义（终审 P1） */
export function accountFailuresInWindow(userKey: string): number {
  const window = getSettingInt('LOGIN_FAIL_WINDOW', 600);
  const row = S().countAccountFailures.get(userKey, Date.now() - window * 1000) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function isBanned(ip: string): BanRow | null {
  const ban = S().getBan.get(ip) as BanRow | undefined;
  if (!ban) return null;
  if (ban.banned_until > Date.now()) return ban;
  // 已过期：返回未封禁。注意**不在这里删行**——repeat_count（累犯计数）
  // 依赖旧行在重新封禁时自增；过期行由 purgeExpired 按 30 天保留期清理。
  return null;
}

export interface FailureResult {
  banned: boolean;
  failures: number;
  bannedUntil?: number;
}

export function recordFailure(ip: string, subject: string | null, reason?: string): FailureResult {
  S().insertAttempt.run(ip, subject ?? null, 0, reason ?? null, Date.now());

  // 频率型自动封禁（累犯倍增）
  const threshold = getSettingInt('IP_BAN_THRESHOLD', 10);
  const fails = failuresInWindow(ip);
  const existing = S().getBan.get(ip) as BanRow | undefined;
  if (fails >= threshold && (!existing || existing.banned_until <= Date.now())) {
    const base = getSettingInt('IP_BAN_BASE_SECONDS', 3600);
    const max = getSettingInt('IP_BAN_MAX_SECONDS', 86400);
    const mult = getSettingInt('IP_BAN_MULTIPLIER', 2);
    const repeat = existing ? existing.repeat_count : 0;
    const dur = Math.min(base * Math.pow(mult, repeat), max);
    const until = Date.now() + dur * 1000;
    S().upsertBan.run(ip, until, Date.now());
    audit(subject ?? ip, ip, 'ip.ban.auto', { reason, failures: fails, banned_until: until, duration_sec: dur });
    return { banned: true, failures: fails, bannedUntil: until };
  }
  return { banned: false, failures: fails };
}

export function recordSuccess(ip: string, subject: string | null): void {
  S().insertAttempt.run(ip, subject ?? null, 1, null, Date.now());
}

// ---------- PoW token（绑 IP、一次性、短时效） ----------

export function issuePowToken(ip: string): string {
  const token = randomBytes(32).toString('hex');
  const ttl = getSettingInt('POW_TOKEN_TTL', 300);
  const now = Date.now();
  S().insertPowToken.run(token, ip, now, now + ttl * 1000);
  return token;
}

/** 读后即删（一次性）；过期或 IP 不符均拒绝 */
export function consumePowToken(token: string, ip: string): boolean {
  const row = S().getPow.get(token) as { expires_at: number; ip: string } | undefined;
  if (!row) return false;
  S().delPow.run(token);
  if (row.expires_at <= Date.now()) return false;
  if (row.ip !== ip) return false;
  return true;
}

/** 某 IP/账号当前登录是否需要 PoW（任一维度失败超阈值即要求） */
export function needsPow(ip: string, userKey?: string | null): boolean {
  if (!getSettingBool('POW_ENABLED', true)) return false;
  const threshold = getSettingInt('LOGIN_FAIL_THRESHOLD', 5);
  if (failuresInWindow(ip) >= threshold) return true;
  if (userKey && accountFailuresInWindow(userKey) >= threshold) return true;
  return false;
}

/** 根据 IP 失败次数计算 PoW 难度（前导零位数；保证浏览器可解） */
export function powDifficulty(ip: string): number {
  const base = getSettingInt('POW_DIFFICULTY_BASE', 16);
  const step = getSettingInt('POW_DIFFICULTY_STEP', 2);
  const max = getSettingInt('POW_DIFFICULTY_MAX', 24);
  const over = Math.max(0, failuresInWindow(ip) - getSettingInt('LOGIN_FAIL_THRESHOLD', 5));
  return Math.min(base + over * step, max);
}
