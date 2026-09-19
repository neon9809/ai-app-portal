import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, initDb } from '../db/index.js';
import { seedSettings } from '../lib/settings.js';
import { createSession } from '../lib/session.js';

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

/**
 * 直建 full 态会话 cookie（fixture 用）。管理员 fixture 置 mfaEnabled=true 后，
 * HTTP 登录只给 password_ok 半登录态（过不了 requireAuth）；本助手等价于
 * 「登录 + 完成 MFA 验证」后的完整会话，并像登录一样授予步升窗口。
 * 供「业务功能测试需要管理员会话」的测试文件使用（认证状态机本身在
 * auth.test.ts / mfa.test.ts 覆盖）。
 */
export function sessionCookieFor(userId: number): string {
  let token = '';
  createSession(
    {
      cookie: (_name: string, value: string) => {
        token = value;
      },
    } as never,
    { id: userId },
    { grantStepUp: true },
  );
  return `aap_sid=${token}`;
}
