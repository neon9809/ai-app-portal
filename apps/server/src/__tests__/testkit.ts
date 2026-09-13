import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, initDb } from '../db/index.js';
import { seedSettings } from '../lib/settings.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/** 每个测试文件一次：临时库 + 迁移 + 默认种子（vitest forks 隔离模块图） */
export function setupTestDb(opts?: { seed?: boolean }): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aap-t-'));
  const file = path.join(dir, 't.db');
  initDb({ file, migrationsDir: MIGRATIONS_DIR });
  if (opts?.seed !== false) seedSettings();
  return { dir, file };
}

export function teardownTestDb(dir: string): void {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
}
