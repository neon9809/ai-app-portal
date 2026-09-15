/**
 * DB 装配：better-sqlite3 + Drizzle。WAL + 外键；启动时跑 drizzle 迁移。
 * 测试里对每个临时库调用 initDb（vitest forks 隔离，单例安全）。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

let sqlite: Database.Database | null = null;
let db: Db | null = null;

export function initDb(opts: { file: string; migrationsDir: string }): void {
  if (db) return;
  fs.mkdirSync(path.dirname(opts.file), { recursive: true });
  sqlite = new Database(opts.file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: opts.migrationsDir });
  hardenDbFilePerms(opts.file);
}

/** 数据库三件套收紧为仅属主可读写：沙箱降权（SANDBOX_UID）后 aap 用户对 /data
 *  只应有遍历权，app.db 的口令/会话哈希不应被包代码读取（二轮渗透实测只读直连可读）。
 *  WAL 的 -wal/-shm 会在 checkpoint 后以 umask 默认权限重建，故挂周期兜底；
 *  文件尚不存在（如 -shm 未生成）时跳过，尽力而为。 */
function hardenDbFilePerms(file: string): void {
  const chmodAll = (): void => {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        fs.chmodSync(f, 0o600);
      } catch {
        /* 未生成/已删除：跳过 */
      }
    }
  };
  chmodAll();
  const timer = setInterval(chmodAll, 60_000);
  timer.unref?.();
}

export function getDb(): Db {
  if (!db) throw new Error('DB not initialized: call initDb() first');
  return db;
}

export function getSqlite(): Database.Database {
  if (!sqlite) throw new Error('DB not initialized: call initDb() first');
  return sqlite;
}

export function closeDb(): void {
  sqlite?.close();
  sqlite = null;
  db = null;
}

export { schema };
