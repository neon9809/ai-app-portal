/**
 * 审计日志——移植自参考实现 lib/audit.js：
 * 写入失败仅 console.error 不影响业务；保留期内分批清理过期数据，
 * 大表走小批量 DELETE + 让出事件循环，避免阻塞。
 */
import { getSqlite } from '../db/index.js';
import { getSettingInt } from './settings.js';

export type AuditDetail = Record<string, unknown> | string | null | undefined;

export function audit(actor: string, ip: string | null | undefined, action: string, detail?: AuditDetail): void {
  try {
    getSqlite()
      .prepare('INSERT INTO audit_logs(ts, actor, ip, action, detail) VALUES (?, ?, ?, ?, ?)')
      .run(
        Date.now(),
        actor,
        ip ?? null,
        action,
        detail === undefined || detail === null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
      );
  } catch (err) {
    console.error('[audit] 写入失败:', err);
  }
}

const DAY_MS = 86_400_000;
const BATCH = 5000;

function purgeBatched(table: string, column: string, olderThan: number): number {
  const s = getSqlite();
  const stmt = s.prepare(
    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ?)`,
  );
  let total = 0;
  let changes: number;
  do {
    changes = Number(stmt.run(olderThan, BATCH).changes);
    total += changes;
    if (changes >= BATCH) setImmediate(() => {}); // 让出事件循环
  } while (changes >= BATCH);
  return total;
}

/** 清理过期：审计/登录尝试按保留期；会话/PoW/封禁按各自语义 */
export function purgeExpired(now = Date.now()): void {
  try {
    const retentionDays = getSettingInt('AUDIT_RETENTION_DAYS', 90);
    purgeBatched('audit_logs', 'ts', now - retentionDays * DAY_MS);
    purgeBatched('login_attempts', 'created_at', now - retentionDays * DAY_MS);
    purgeBatched('sessions', 'expires_at', now - 7 * DAY_MS); // 过期会话多留 7 天供会话列表展示
    purgeBatched('pow_challenges', 'expires_at', now);
    purgeBatched('pow_tokens', 'expires_at', now);
    purgeBatched('ip_bans', 'banned_until', now - 30 * DAY_MS); // 过期封禁留 30 天供查看累犯
  } catch (err) {
    console.error('[audit] 清理失败:', err);
  }
}

let timer: NodeJS.Timeout | null = null;

export function startPurgeLoop(): void {
  if (timer) return;
  purgeExpired();
  timer = setInterval(() => purgeExpired(), 3600_000);
  timer.unref();
}

export function stopPurgeLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
