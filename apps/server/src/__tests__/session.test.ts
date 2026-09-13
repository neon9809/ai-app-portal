import type { Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { getDb, getSqlite } from '../db/index.js';
import { users } from '../db/schema.js';
import { createSession, destroySessionByToken, hashToken, loadSessionByToken } from '../lib/session.js';

let dir: string;

/** 最小 Response stub：捕获 cookie 写入 */
function stubRes(): { res: Response; cookie: () => { name: string; value: string } | null } {
  const holder: { cookie: { name: string; value: string } | null } = { cookie: null };
  const res = {
    cookie(name: string, value: string) {
      holder.cookie = { name, value };
    },
    clearCookie() {
      holder.cookie = null;
    },
  } as unknown as Response;
  return { res, cookie: () => holder.cookie };
}

function insertUser(username: string, status = 'active'): number {
  const info = getDb()
    .insert(users)
    .values({ kind: 'local', username, name: username, role: 'user', status, createdAt: Date.now() })
    .run();
  return Number(info.lastInsertRowid);
}

beforeAll(() => {
  ({ dir } = setupTestDb());
});
afterAll(() => teardownTestDb(dir));

describe('session（统一 users 表）', () => {
  it('创建→装载→登出 全链路', () => {
    const uid = insertUser('alice');
    const { res, cookie } = stubRes();
    const token = createSession(res, { id: uid }, { ip: '1.2.3.4', userAgent: 'vitest' });
    expect(cookie()).toMatchObject({ name: 'aap_sid' });

    const u = loadSessionByToken(token);
    expect(u).not.toBeNull();
    expect(u!.id).toBe(uid);
    expect(u!.kind).toBe('local');
    expect(u!.subject).toBe('local:alice');
    expect(u!.authState).toBe('full');

    destroySessionByToken(token);
    expect(loadSessionByToken(token)).toBeNull();
  });

  it('半登录态（password_ok）被原样装载（W4 状态机数据基础）', () => {
    const uid = insertUser('bob');
    const { res } = stubRes();
    const token = createSession(res, { id: uid }, { authState: 'password_ok' });
    expect(loadSessionByToken(token)!.authState).toBe('password_ok');
  });

  it('过期会话装载即删', () => {
    const uid = insertUser('carol');
    const token = 'tok-expired-test';
    getSqlite()
      .prepare(
        `INSERT INTO sessions(token_hash, user_id, auth_state, created_at, last_seen_at, expires_at)
         VALUES (?, ?, 'full', ?, ?, ?)`,
      )
      .run(hashToken(token), uid, Date.now(), Date.now(), Date.now() - 1000);
    expect(loadSessionByToken(token)).toBeNull();
    expect(
      getSqlite().prepare('SELECT COUNT(*) n FROM sessions WHERE token_hash = ?').get(hashToken(token)),
    ).toMatchObject({ n: 0 });
  });

  it('禁用用户会话即刻作废', () => {
    const uid = insertUser('dave', 'disabled');
    const { res } = stubRes();
    const token = createSession(res, { id: uid }, {});
    expect(loadSessionByToken(token)).toBeNull();
  });

  it('token 只存 SHA-256 哈希', () => {
    const uid = insertUser('erin');
    const { res } = stubRes();
    const token = createSession(res, { id: uid }, {});
    const rows = getSqlite().prepare('SELECT token_hash FROM sessions').all() as Array<{ token_hash: string }>;
    expect(rows.some((r) => r.token_hash === token)).toBe(false);
    expect(rows.some((r) => r.token_hash === hashToken(token))).toBe(true);
  });
});
