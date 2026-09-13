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
