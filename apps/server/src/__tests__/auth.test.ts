import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { closeDb } from '../db/index.js';
import { seedSettings, setSetting } from '../lib/settings.js';
import { getDb } from '../db/index.js';
import { inviteCodes } from '../db/schema.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { hasLeadingZeroBits } from '../lib/pow.js';

let server: Server;
let base: string;
let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

/** 客户端 PoW 解题 + 换 token（模拟浏览器 WebCrypto 流程） */
async function solvePow(): Promise<string> {
  const chRes = await fetch(`${base}/api/auth/pow`, { method: 'POST' });
  const { challenge } = (await chRes.json()) as { challenge: { challengeId: string; seed: string; difficulty: number } };
  let nonce = 0;
  for (;; nonce++) {
    const h = createHash('sha256').update(`${challenge.seed}:${nonce}`).digest('hex');
    if (hasLeadingZeroBits(h, challenge.difficulty)) break;
  }
  const vRes = await fetch(`${base}/api/auth/pow/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: challenge.challengeId, nonce: String(nonce) }),
  });
  const { token } = (await vRes.json()) as { token: string };
  return token;
}

/** 从服务端日志兜底通道抓取验证码（未配置 SMTP 时的离线模式） */
function lastCodeFromLog(): string {
  const calls = logSpy.mock.calls as unknown as string[][];
  for (let i = calls.length - 1; i >= 0; i--) {
    const line = String(calls[i]?.[0] ?? '');
    const m = line.match(/code=(\d{6})/);
    if (m) return m[1]!;
  }
  throw new Error('日志中未找到验证码');
}

function cookieOf(res: Response): string {
  const cookies = res.headers.getSetCookie();
  const sid = cookies.find((c) => c.startsWith('aap_sid='));
  if (!sid) throw new Error('no session cookie');
  return sid.split(';')[0]!;
}

beforeAll(async () => {
  ({ dir } = setupTestDb());
  seedSettings();
  logSpy = vi.spyOn(console, 'log');
  const cfg = { ...loadConfig({}), webDist: null };
  server = createApp(cfg).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  logSpy.mockRestore();
  closeDb();
  teardownTestDb(dir);
});

describe('W3 注册（A2）', () => {
  it('默认关闭注册 → 403', async () => {
    const res = await fetch(`${base}/api/auth/register/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'neo', password: 'password123', email: 'neo@example.com' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('REGISTRATION_CLOSED');
  });

  it('开放注册：无 PoW 拒绝；带 PoW 发码；首账号自动 admin', async () => {
    setSetting('REGISTRATION_MODE', 'open');

    // 无 PoW → 403 POW_REQUIRED（响应附带新挑战）
    const noPow = await fetch(`${base}/api/auth/register/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'neo', password: 'password123', email: 'neo@example.com' }),
    });
    expect(noPow.status).toBe(403);
    expect(((await noPow.json()) as { error: { action?: string } }).error.action).toBe('pow');

    const powToken = await solvePow();
    const res = await fetch(`${base}/api/auth/register/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'neo',
        password: 'password123',
        email: 'neo@example.com',
        powToken,
      }),
    });
    expect(res.status).toBe(200);
    const started = (await res.json()) as { registrationId: string; sentTo: string; viaLogFallback: boolean };
    expect(started.sentTo).toContain('***');
    expect(started.viaLogFallback).toBe(true); // 未配 SMTP → 日志兜底

    const code = lastCodeFromLog();
    // 错误验证码
    const bad = await fetch(`${base}/api/auth/register/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ registrationId: started.registrationId, code: '000001' }),
    });
    expect(bad.status).toBe(400);
    // 正确验证码 → 建号 + 自动登录
    const ok = await fetch(`${base}/api/auth/register/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ registrationId: started.registrationId, code }),
    });
    expect(ok.status).toBe(200);
    const done = (await ok.json()) as { user: { username: string; role: string } };
    expect(done.user.username).toBe('neo');
    expect(done.user.role).toBe('admin'); // 首账号自动 admin

    // 会话可用
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: cookieOf(ok) } });
    expect(me.status).toBe(200);
    const info = (await me.json()) as { user: { username: string }; mustEnrollMfa: boolean };
    expect(info.user.username).toBe('neo');
    expect(info.mustEnrollMfa).toBe(true); // admin 强制 MFA（W4 落地绑定流程）
  });

  it('60s 重发限流在「找回密码」用例中覆盖（同邮箱连发 → 429）', () => {
    // 限流断言见 W3 找回密码 用例（需要真实存在的收件用户）
    expect(true).toBe(true);
  });
});

describe('W3 登录/会话', () => {
  it('CSRF：跨站 Origin 被拒', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ username: 'neo', password: 'password123' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CSRF_ORIGIN_MISMATCH');
  });

  it('错误密码 → 401；正确密码 → 会话；重复登录正常', async () => {
    const bad = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'neo', password: 'wrong-password' }),
    });
    expect(bad.status).toBe(401);

    const ok = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'neo', password: 'password123' }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { authState: string; mfaRequired: boolean };
    expect(body.authState).toBe('full');
    expect(body.mfaRequired).toBe(false);
  });

  it('改密：旧密码校验、其他会话被踢', async () => {
    // 两个会话
    const login1 = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'neo', password: 'password123' }),
    });
    const login2 = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'neo', password: 'password123' }),
    });
    const c1 = cookieOf(login1);
    const c2 = cookieOf(login2);

    // 旧密码错误
    const wrong = await fetch(`${base}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: c1 },
      body: JSON.stringify({ currentPassword: 'nope-nope', newPassword: 'newPassword456' }),
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`${base}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: c1 },
      body: JSON.stringify({ currentPassword: 'password123', newPassword: 'newPassword456' }),
    });
    expect(ok.status).toBe(200);

    // c2（改密前的其他会话）被踢
    const me2 = await fetch(`${base}/api/auth/me`, { headers: { cookie: c2 } });
    expect(me2.status).toBe(401);
    // c1 保留
    const me1 = await fetch(`${base}/api/auth/me`, { headers: { cookie: c1 } });
    expect(me1.status).toBe(200);

    // 用新密码登录成功
    const relogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'neo', password: 'newPassword456' }),
    });
    expect(relogin.status).toBe(200);
  });
});

describe('W3 找回密码（防枚举）', () => {
  it('不存在的邮箱也返回 ok；存在的邮箱走码重置', async () => {
    // 专用用户（直插 DB，避免与注册流程的限流/占用相互纠缠）
    const { writeLocalCredentials } = await import('../lib/bootstrap.js');
    const info = getDb()
      .insert((await import('../db/schema.js')).users)
      .values({ kind: 'local', username: 'resetguy', email: 'resetguy@example.com', name: 'rg', createdAt: Date.now() })
      .run();
    await writeLocalCredentials(Number(info.lastInsertRowid), 'originalPassword1');

    const token = await solvePow();
    const ghost = await fetch(`${base}/api/auth/forgot/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: 'ghost@example.com', powToken: token }),
    });
    expect(ghost.status).toBe(200);

    const token2 = await solvePow();
    const start = await fetch(`${base}/api/auth/forgot/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: 'resetguy@example.com', powToken: token2 }),
    });
    expect(start.status).toBe(200);
    const code = lastCodeFromLog();

    // 60s 内对同一邮箱再次发码 → 429（限流按通道+目标计）
    const token3 = await solvePow();
    const again = await fetch(`${base}/api/auth/forgot/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: 'resetguy@example.com', powToken: token3 }),
    });
    expect(again.status).toBe(429);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('CODE_RESEND_TOO_FAST');

    const verify = await fetch(`${base}/api/auth/forgot/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: 'resetguy@example.com', code, newPassword: 'resetPassword789' }),
    });
    expect(verify.status).toBe(200);

    const relogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'resetguy', password: 'resetPassword789' }),
    });
    expect(relogin.status).toBe(200);
  });
});

describe('W3 邀请码注册', () => {
  it('invite 模式：无邀请码拒绝，有效邀请码通过且一次性', async () => {
    setSetting('REGISTRATION_MODE', 'invite');
    getDb()
      .insert(inviteCodes)
      .values({ code: 'INVITE-XYZ', createdAt: Date.now() })
      .run();

    const noInvite = await fetch(`${base}/api/auth/register/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        username: 'guest',
        password: 'password123',
        email: 'guest@example.com',
        powToken: await solvePow(),
      }),
    });
    expect(noInvite.status).toBe(403);

    const withInvite = await fetch(`${base}/api/auth/register/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        username: 'guest',
        password: 'password123',
        email: 'guest@example.com',
        inviteCode: 'INVITE-XYZ',
        powToken: await solvePow(),
      }),
    });
    expect(withInvite.status).toBe(200);
    const { registrationId } = (await withInvite.json()) as { registrationId: string };
    const code = lastCodeFromLog();
    const done = await fetch(`${base}/api/auth/register/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ registrationId, code }),
    });
    expect(done.status).toBe(200);
    const { user } = (await done.json()) as { user: { role: string } };
    expect(user.role).toBe('user'); // 非首账号，不提升

    // 邀请码已消耗：同一码第二次 start 失败
    const again = await fetch(`${base}/api/auth/register/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        username: 'guest2',
        password: 'password123',
        email: 'guest2@example.com',
        inviteCode: 'INVITE-XYZ',
        powToken: await solvePow(),
      }),
    });
    expect(again.status).toBe(403);
  });
});
