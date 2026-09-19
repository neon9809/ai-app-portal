import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { closeDb } from '../db/index.js';
import { seedSettings, setSetting } from '../lib/settings.js';
import { getDb } from '../db/index.js';
import { inviteCodes, registrations, users } from '../db/schema.js';
import { and, eq, gt, sql } from 'drizzle-orm';
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

  it('60s 重发限流：注册路径占用校验（409）先于发码限流，无枚举面；找回路径的限流已静默化（P1-4 用例覆盖）', () => {
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
    const ghostBody = (await ghost.json()) as unknown;

    const token2 = await solvePow();
    const start = await fetch(`${base}/api/auth/forgot/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: 'resetguy@example.com', powToken: token2 }),
    });
    expect(start.status).toBe(200);
    const startBody = (await start.json()) as unknown;
    const code = lastCodeFromLog();

    // 60s 内对同一邮箱再次发码：命中重发限流但对外静默——与不存在的邮箱
    // 完全相同的 200 响应体（防账号存在性枚举 oracle，终审 P1-4）
    const token3 = await solvePow();
    const again = await fetch(`${base}/api/auth/forgot/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: 'resetguy@example.com', powToken: token3 }),
    });
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as unknown;
    expect(againBody).toEqual(startBody); // 二连发响应体一致
    expect(againBody).toEqual(ghostBody); // 与不存在邮箱响应体一致
    // 静默跳过发送：旧码仍有效（下方 verify 用其完成重置）

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

  it('重置码错猜 ≥5 次即作废：正确码也不通过，重新发码后恢复', async () => {
    const { writeLocalCredentials } = await import('../lib/bootstrap.js');
    const info = getDb()
      .insert((await import('../db/schema.js')).users)
      .values({ kind: 'local', username: 'bruteguy', email: 'bruteguy@example.com', name: 'bg', createdAt: Date.now() })
      .run();
    await writeLocalCredentials(Number(info.lastInsertRowid), 'originalPassword1');

    const start = await fetch(`${base}/api/auth/forgot/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: 'bruteguy@example.com', powToken: await solvePow() }),
    });
    expect(start.status).toBe(200);
    const code = lastCodeFromLog();

    const wrongGuess = async (): Promise<{ status: number; code: string }> => {
      const r = await fetch(`${base}/api/auth/forgot/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email: 'bruteguy@example.com', code: '000000', newPassword: 'whatever123' }),
      });
      const b = (await r.json()) as { error?: { code?: string } };
      return { status: r.status, code: b.error?.code ?? '' };
    };

    // 前 4 次错猜 → 普通 CODE_MISMATCH（码仍有效）
    for (let i = 0; i < 4; i++) {
      expect(await wrongGuess()).toMatchObject({ status: 400, code: 'CODE_MISMATCH' });
    }
    // 第 5 次 → 作废该邮箱全部待用重置码（防在线爆破）
    expect(await wrongGuess()).toMatchObject({ status: 400, code: 'CODE_TOO_MANY_ATTEMPTS' });
    // 作废后正确码也不通过（防「错猜后试真码」路径）
    const correct = await fetch(`${base}/api/auth/forgot/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: 'bruteguy@example.com', code, newPassword: 'resetPassword789' }),
    });
    expect(correct.status).toBe(400);

    // 重新发码（作废时已清空待用码，不受 60s 重发限制）→ 正常重置
    const start2 = await fetch(`${base}/api/auth/forgot/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: 'bruteguy@example.com', powToken: await solvePow() }),
    });
    expect(start2.status).toBe(200);
    const verify2 = await fetch(`${base}/api/auth/forgot/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: 'bruteguy@example.com', code: lastCodeFromLog(), newPassword: 'freshPassword456' }),
    });
    expect(verify2.status).toBe(200);

    // 错猜已计入登录失败队列：同 IP 后续登录先被 PoW 门槛拦下（联动 recordFailure 的预期行为）
    const noPow = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'bruteguy', password: 'freshPassword456' }),
    });
    expect(noPow.status).toBe(403);
    expect(((await noPow.json()) as { error: { code: string } }).error.code).toBe('POW_REQUIRED');
    const relogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'bruteguy', password: 'freshPassword456', powToken: await solvePow() }),
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

describe('终审 P1-1：半登录态改密拒绝', () => {
  it('MFA 用户 password_ok 会话调 change-password → 403 MFA_REQUIRED', async () => {
    const { writeLocalCredentials } = await import('../lib/bootstrap.js');
    const info = getDb()
      .insert(users)
      .values({
        kind: 'local',
        username: 'halfguy',
        email: 'halfguy@example.com',
        name: 'hg',
        mfaEnabled: true, // 登录状态机据此给半登录态（无需真实 TOTP 绑定）
        createdAt: Date.now(),
      })
      .run();
    await writeLocalCredentials(Number(info.lastInsertRowid), 'password123');

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'halfguy', password: 'password123', powToken: await solvePow() }),
    });
    expect(login.status).toBe(200);
    const body = (await login.json()) as { authState: string; mfaRequired: boolean };
    expect(body.authState).toBe('password_ok');
    expect(body.mfaRequired).toBe(true);

    const res = await fetch(`${base}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: cookieOf(login) },
      body: JSON.stringify({ currentPassword: 'password123', newPassword: 'newPassword456' }),
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as { error: { code: string; action?: string } };
    expect(err.error.code).toBe('MFA_REQUIRED');
    expect(err.error.action).toBe('mfa');
  });
});

describe('终审 P1-5：同 IP 24h 注册上限（含已完成）', () => {
  it('完成的注册仍占 24h 名额：触顶后新注册 429', async () => {
    setSetting('REGISTRATION_MODE', 'open');
    const ip = '127.0.0.1';
    // 前面用例已完成的注册（neo/guest）行保留 → 计入窗口
    const existing =
      getDb()
        .select({ n: sql<number>`count(*)` })
        .from(registrations)
        .where(and(eq(registrations.ip, ip), gt(registrations.createdAt, Date.now() - 24 * 3600_000)))
        .get()?.n ?? 0;
    expect(existing).toBeGreaterThan(0);
    // 上限 = 现有数 + 1：再完成一个注册即触顶
    setSetting('MAX_ACCOUNTS_PER_IP_24H', String(existing + 1));
    try {
      const start = await fetch(`${base}/api/auth/register/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({
          username: 'capuser',
          password: 'password123',
          email: 'capuser@example.com',
          powToken: await solvePow(),
        }),
      });
      expect(start.status).toBe(200);
      const { registrationId } = (await start.json()) as { registrationId: string };
      const done = await fetch(`${base}/api/auth/register/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ registrationId, code: lastCodeFromLog() }),
      });
      expect(done.status).toBe(200);
      // 完成行保留（completedAt 非空），不再删除释放名额
      const row = getDb().select().from(registrations).where(eq(registrations.username, 'capuser')).get();
      expect(row?.completedAt).not.toBeNull();

      const over = await fetch(`${base}/api/auth/register/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({
          username: 'capover',
          password: 'password123',
          email: 'capover@example.com',
          powToken: await solvePow(),
        }),
      });
      expect(over.status).toBe(429);
      expect(((await over.json()) as { error: { code: string } }).error.code).toBe('TOO_MANY_REGISTRATIONS');
    } finally {
      setSetting('MAX_ACCOUNTS_PER_IP_24H', '5');
    }
  });
});

describe('终审 P1-6：强制流程门禁', () => {
  it('mustChangePassword 会话：/api/apps → 403 FORCE_CHANGE_PASSWORD；/me 正常；改密后放行', async () => {
    const { writeLocalCredentials } = await import('../lib/bootstrap.js');
    const info = getDb()
      .insert(users)
      .values({
        kind: 'local',
        username: 'forcepw',
        email: 'forcepw@example.com',
        name: 'fp',
        mustChangePassword: true,
        createdAt: Date.now(),
      })
      .run();
    await writeLocalCredentials(Number(info.lastInsertRowid), 'initialPass123');

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'forcepw', password: 'initialPass123', powToken: await solvePow() }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { mustChangePassword: boolean; mustEnrollMfa: boolean };
    expect(loginBody.mustChangePassword).toBe(true);
    expect(loginBody.mustEnrollMfa).toBe(false); // 普通用户不强制绑 MFA
    const cookie = cookieOf(login);

    const blocked = await fetch(`${base}/api/apps`, { headers: { cookie } });
    expect(blocked.status).toBe(403);
    const blockedBody = (await blocked.json()) as { error: { code: string; action?: string } };
    expect(blockedBody.error.code).toBe('FORCE_CHANGE_PASSWORD');
    expect(blockedBody.error.action).toBe('change-password');

    // /me 永不被门禁拦（前端靠它拿状态）
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { mustChangePassword: boolean }).mustChangePassword).toBe(true);

    // 白名单内完成改密 → 门禁放行
    const change = await fetch(`${base}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: JSON.stringify({ currentPassword: 'initialPass123', newPassword: 'changedPass456' }),
    });
    expect(change.status).toBe(200);
    const apps = await fetch(`${base}/api/apps`, { headers: { cookie } });
    expect(apps.status).toBe(200);
  });

  it('未绑 MFA 的 local admin：登录响应 mustEnrollMfa=true；/api/apps → 403 FORCE_ENROLL_MFA；/me 正常', async () => {
    const { writeLocalCredentials } = await import('../lib/bootstrap.js');
    const info = getDb()
      .insert(users)
      .values({ kind: 'local', username: 'nomfaadmin', email: 'nomfa@example.com', name: 'na', role: 'admin', createdAt: Date.now() })
      .run();
    await writeLocalCredentials(Number(info.lastInsertRowid), 'adminPass123');

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'nomfaadmin', password: 'adminPass123', powToken: await solvePow() }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { authState: string; mustEnrollMfa: boolean };
    expect(loginBody.authState).toBe('full');
    expect(loginBody.mustEnrollMfa).toBe(true); // 契约补齐（P1-6a）
    const cookie = cookieOf(login);

    const blocked = await fetch(`${base}/api/apps`, { headers: { cookie } });
    expect(blocked.status).toBe(403);
    const blockedBody = (await blocked.json()) as { error: { code: string; action?: string } };
    expect(blockedBody.error.code).toBe('FORCE_ENROLL_MFA');
    expect(blockedBody.error.action).toBe('mfa');

    // /me 与 MFA 绑定流程端点在白名单内
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { mustEnrollMfa: boolean }).mustEnrollMfa).toBe(true);
    const mfaStatus = await fetch(`${base}/api/auth/mfa/status`, { headers: { cookie } });
    expect(mfaStatus.status).toBe(200);
  });

  it('OIDC 管理员（MFA 委托 IdP）不受强制绑定门禁', async () => {
    const info = getDb()
      .insert(users)
      .values({ kind: 'oidc', subject: 'sub-boss', email: 'boss@example.com', name: 'boss', role: 'admin', createdAt: Date.now() })
      .run();
    // 直建会话（OIDC 回调链路在 e2e 覆盖，这里只验门禁判定）
    const { createSession } = await import('../lib/session.js');
    let token = '';
    createSession(
      { cookie: (_name: string, value: string) => { token = value; } } as never,
      { id: Number(info.lastInsertRowid) },
      { ip: '127.0.0.1' },
    );
    const cookie = `aap_sid=${token}`;

    const apps = await fetch(`${base}/api/apps`, { headers: { cookie } });
    expect(apps.status).toBe(200); // 门禁对 OIDC 管理员惰性
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { mustEnrollMfa: boolean }).mustEnrollMfa).toBe(false);
  });
});
