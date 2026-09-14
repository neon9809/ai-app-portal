import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generate } from 'otplib';
import { eq } from 'drizzle-orm';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { closeDb, getDb } from '../db/index.js';
import { seedSettings } from '../lib/settings.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { totpSecrets, users } from '../db/schema.js';
import { decryptSecret } from '../lib/cryptoSecrets.js';
import { writeLocalCredentials } from '../lib/bootstrap.js';
import { remainingRecoveryCodes } from '../lib/mfa.js';

let server: Server;
let base: string;
let dir: string;
let seq = 0;

function cookieOf(res: Response): string {
  const cookies = res.headers.getSetCookie();
  const sid = cookies.find((c) => c.startsWith('aap_sid='));
  if (!sid) throw new Error('no session cookie');
  return sid.split(';')[0]!;
}

async function jsonPost(path: string, body: unknown, cookie?: string) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/**
 * 每个测试用例独立的用户 + 以「固定计数器基准」生成各窗口令牌：
 *  - confirm 用 delta=-1（上一个窗，服务端 ±1 容忍）
 *  - 登录验证用 delta=0（当前窗，counter 更大 → 非重放）
 *  - 步升用 delta=+1
 * 同一 30s 窗口内同一用户最多 3 次验证（TPM 设计使然），用例据此编排。
 */
async function setupUserWithTotp(): Promise<{
  userId: number;
  username: string;
  secret: string;
  token: (delta: number) => Promise<string>;
  /** enroll 前的完整登录会话（confirm 后 authState 仍为 full） */
  fullCookie: string;
}> {
  const n = ++seq;
  const username = `mfauser${n}`;
  const info = getDb()
    .insert(users)
    .values({ kind: 'local', username, name: username, role: 'user', createdAt: Date.now() })
    .run();
  const userId = Number(info.lastInsertRowid);
  await writeLocalCredentials(userId, 'password123');

  const login = await jsonPost('/api/auth/login', { username, password: 'password123' });
  expect(login.status).toBe(200);
  const cookie = cookieOf(login);

  const enroll = await jsonPost('/api/auth/mfa/totp/enroll', {}, cookie);
  expect(enroll.status).toBe(200);
  const { secret } = (await enroll.json()) as { secret: string };

  const confirm = await jsonPost('/api/auth/mfa/totp/confirm', { token: await tokenFor(secret, -1) }, cookie);
  expect(confirm.status).toBe(200);
  return { userId, username, secret, token: (delta) => tokenFor(secret, delta), fullCookie: cookie };
}

async function tokenFor(secret: string, delta: number): Promise<string> {
  const counter = Math.floor(Date.now() / 1000 / 30) + delta;
  return generate({ secret, epoch: counter * 30 });
}

/** 完整登录（密码 + TOTP），返回会话 cookie */
async function fullLogin(username: string, secret: string): Promise<string> {
  const login = await jsonPost('/api/auth/login', { username, password: 'password123' });
  expect(login.status).toBe(200);
  const cookie = cookieOf(login);
  const v = await jsonPost('/api/auth/mfa/login/totp', { token: await tokenFor(secret, 0) }, cookie);
  expect(v.status).toBe(200);
  return cookie;
}

beforeAll(async () => {
  ({ dir } = setupTestDb());
  seedSettings();
  const cfg = { ...loadConfig({}), webDist: null };
  server = createApp(cfg).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  teardownTestDb(dir);
});

describe('W4 MFA（TOTP + 状态机 + 恢复码 + 步升）', () => {
  it('绑定：enroll → confirm（发恢复码）→ mfaEnabled=true', async () => {
    const { userId, fullCookie } = await setupUserWithTotp();
    expect(remainingRecoveryCodes(userId)).toBe(10);

    // enroll 前的完整会话仍是 full（confirm 不降级），/me 可见 mfaEnabled
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: fullCookie } });
    expect(me.status).toBe(200);
    const info = (await me.json()) as { user: { mfaEnabled: boolean }; mustEnrollMfa: boolean };
    expect(info.user.mfaEnabled).toBe(true);
    expect(info.mustEnrollMfa).toBe(false);
  });

  it('登录状态机：password_ok → totp 验证 → full；半登录不能读 /me；重放拒绝', async () => {
    const { username, secret, token } = await setupUserWithTotp();

    const login = await jsonPost('/api/auth/login', { username, password: 'password123' });
    const body = (await login.json()) as { authState: string; mfaRequired: boolean };
    expect(body.authState).toBe('password_ok');
    expect(body.mfaRequired).toBe(true);
    const cookie = cookieOf(login);

    // 半登录态不能读完整资料
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(403);
    expect(((await me.json()) as { error: { code: string } }).error.code).toBe('MFA_REQUIRED');

    // 挑战页可读 MFA 状态
    const status = await fetch(`${base}/api/auth/mfa/status`, { headers: { cookie } });
    expect(status.status).toBe(200);
    const st = (await status.json()) as { totpConfirmed: boolean };
    expect(st.totpConfirmed).toBe(true);

    // delta=0（confirm 消耗了 -1 窗，0 窗更新鲜）
    const ok = await jsonPost('/api/auth/mfa/login/totp', { token: await token(0) }, cookie);
    expect(ok.status).toBe(200);
    const done = (await ok.json()) as { authState: string };
    expect(done.authState).toBe('full');

    // 同一枚码（0 窗）再次验证 → 重放拒绝
    const login2 = await jsonPost('/api/auth/login', { username, password: 'password123' });
    const cookie2 = cookieOf(login2);
    const replay = await jsonPost('/api/auth/mfa/login/totp', { token: await token(0) }, cookie2);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe('TOTP_REPLAYED');
  });

  it('TOTP 错猜节流：同一会话错猜 ≥5 次会话作废；重新登录不受影响', async () => {
    const { username, secret } = await setupUserWithTotp();
    const login = await jsonPost('/api/auth/login', { username, password: 'password123' });
    const cookie = cookieOf(login);

    // 前 4 次普通失败；第 5 次触发会话作废
    for (let i = 0; i < 4; i++) {
      const bad = await jsonPost('/api/auth/mfa/login/totp', { token: '000000' }, cookie);
      expect(bad.status).toBe(400);
    }
    const fifth = await jsonPost('/api/auth/mfa/login/totp', { token: '000000' }, cookie);
    expect(fifth.status).toBe(400);
    expect(((await fifth.json()) as { error: { code: string } }).error.code).toBe('MFA_TOO_MANY_ATTEMPTS');

    // 会话已删除（防持密码会话在线穷举第二因子）
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(401);

    // 重新登录走完整流程不受影响
    const okCookie = await fullLogin(username, secret);
    const me2 = await fetch(`${base}/api/auth/me`, { headers: { cookie: okCookie } });
    expect(me2.status).toBe(200);
  });

  it('步升认证 + 恢复码一枚一用', async () => {
    const { username, secret, token } = await setupUserWithTotp();
    const cookie = await fullLogin(username, secret);

    // 登录即授予步升窗口（新语义，强制绑 MFA 依赖它）；清零以模拟陈旧会话
    const { sessions } = await import('../db/schema.js');
    getDb().update(sessions).set({ stepUpUntil: null }).run();

    // 未步升 → regenerate 被拒
    const noStep = await jsonPost('/api/auth/mfa/recovery/regenerate', {}, cookie);
    expect(noStep.status).toBe(403);
    expect(((await noStep.json()) as { error: { code: string } }).error.code).toBe('STEP_UP_REQUIRED');

    // 步升（+1 窗）→ regenerate
    const step = await jsonPost('/api/auth/step-up/totp', { token: await token(1) }, cookie);
    expect(step.status).toBe(200);
    const regen = await jsonPost('/api/auth/mfa/recovery/regenerate', {}, cookie);
    expect(regen.status).toBe(200);
    const { recoveryCodes } = (await regen.json()) as { recoveryCodes: string[] };

    // 登出后用恢复码完成 MFA 登录（恢复码不受窗口计数约束）
    await jsonPost('/api/auth/logout', {}, cookie);
    const login2 = await jsonPost('/api/auth/login', { username, password: 'password123' });
    const cookie2 = cookieOf(login2);
    const viaRec = await jsonPost('/api/auth/mfa/login/totp', { token: recoveryCodes[0] }, cookie2);
    expect(viaRec.status).toBe(200);

    // 同一枚恢复码第二次用 → 拒绝
    const login3 = await jsonPost('/api/auth/login', { username, password: 'password123' });
    const cookie3 = cookieOf(login3);
    const reuse = await jsonPost('/api/auth/mfa/login/totp', { token: recoveryCodes[0] }, cookie3);
    expect(reuse.status).toBe(400);
  });

  it('admin 强制 MFA：解绑最后一个因子被拒', async () => {
    const { userId, username, secret, token } = await setupUserWithTotp();
    getDb().update(users).set({ role: 'admin' }).where(eq(users.id, userId)).run();
    const cookie = await fullLogin(username, secret);
    const step = await jsonPost('/api/auth/step-up/totp', { token: await token(1) }, cookie);
    expect(step.status).toBe(200);

    const disable = await jsonPost('/api/auth/mfa/totp/disable', {}, cookie);
    expect(disable.status).toBe(403);
    expect(((await disable.json()) as { error: { code: string } }).error.code).toBe('MFA_REQUIRED_FOR_ADMIN');
  });
});
