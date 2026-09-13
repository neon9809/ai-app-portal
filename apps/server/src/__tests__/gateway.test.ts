/**
 * W5 应用网关集成测试：
 *  - mock 上游（HTML/JSON 回显/SSE/重定向）+ WS 回声（ws 包）
 *  - HTML 改写/<base>/猴补丁、Link/Location 改写、头过滤、身份注入验签
 *  - 访问策略三态、路径穿越、双维度限流、urlSecret（query/path 型）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { eq } from 'drizzle-orm';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { closeDb, getDb, getSqlite } from '../db/index.js';
import { seedSettings, setSetting, getSetting } from '../lib/settings.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { handleUpgrade } from '../gateway/wsproxy.js';
import { users } from '../db/schema.js';
import { writeLocalCredentials } from '../lib/bootstrap.js';
import { verifyIdentity } from '../gateway/identity.js';

let gw: Server; // 网关（含 upgrade）
let gwPort = 0;
let up: Server; // mock 上游
let upPort = 0;
let dir: string;
let adminCookie = '';

const PAGE_HTML = `<!doctype html><html><head><title>up</title></head><body>
<link rel="stylesheet" href="/assets/style.css">
<a href="/page">inner</a>
<img src="/img.png" srcset="/img@2x.png 2x">
<script src="/app.js"></script>
</body></html>`;

function cookieOf(res: Response): string {
  const cookies = res.headers.getSetCookie();
  const sid = cookies.find((c) => c.startsWith('aap_sid='));
  if (!sid) throw new Error('no session cookie');
  return sid.split(';')[0]!;
}

async function createAppViaAdmin(payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${gwPort}/api/admin/apps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${gwPort}`, cookie: adminCookie },
    body: JSON.stringify(payload),
  });
  if (res.status !== 200) {
    throw new Error(`create app failed: ${res.status} ${await res.text()}`);
  }
}

beforeAll(async () => {
  ({ dir } = setupTestDb());
  seedSettings();

  // mock 上游
  up = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const pathname = new URL(url, 'http://internal.invalid').pathname;
    if (pathname === '/up') {
      // JSON 回显：url + headers（供断言身份注入/头过滤/query 合并）
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url, headers: req.headers }));
      return;
    }
    if (pathname === '/sse') {
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        res.end();
      }, 50);
      return;
    }
    if (pathname === '/redir') {
      res.statusCode = 302;
      res.setHeader('location', '/landing');
      res.end();
      return;
    }
    if (pathname === '/' || pathname === '/page') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('link', '</assets/preload.css>; rel=preload');
      res.end(PAGE_HTML);
      return;
    }
    // 其余路径一律 JSON 回显（供路径凭据等用例断言上游真实 URL）
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url, headers: req.headers }));
  });
  const wss = new WebSocketServer({ noServer: true });
  up.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => ws.send(`echo:${data.toString()}`));
    });
  });
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  upPort = (up.address() as AddressInfo).port;

  // 网关
  const cfg = { ...loadConfig({}), webDist: null };
  gw = http.createServer(createApp(cfg));
  gw.on('upgrade', handleUpgrade);
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
  gwPort = (gw.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${gwPort}`;

  // 管理员（直插 + 登录）
  const info = getDb()
    .insert(users)
    .values({ kind: 'local', username: 'admin', name: '管理员', role: 'admin', createdAt: Date.now() })
    .run();
  await writeLocalCredentials(Number(info.lastInsertRowid), 'admin-password');
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'admin', password: 'admin-password' }),
  });
  adminCookie = cookieOf(login);

  // 普通用户（plan=free）
  const u = getDb()
    .insert(users)
    .values({ kind: 'local', username: 'freeuser', name: 'free', role: 'user', createdAt: Date.now() })
    .run();
  await writeLocalCredentials(Number(u.lastInsertRowid), 'free-password');

  // 注册应用：公开(passUser) / 需登录 / 会员 / path 型凭据
  await createAppViaAdmin({ id: 'pub', name: '公开应用', upstream: `http://127.0.0.1:${upPort}`, visibility: 'public', passUser: true });
  await createAppViaAdmin({ id: 'priv', name: '登录应用', upstream: `http://127.0.0.1:${upPort}`, visibility: 'login' });
  await createAppViaAdmin({ id: 'vip', name: '受限应用', upstream: `http://127.0.0.1:${upPort}`, visibility: 'restricted', allowedGroupIds: [999999] });
  await createAppViaAdmin({
    id: 'pathsecret',
    name: '路径凭据',
    upstream: `http://127.0.0.1:${upPort}`,
    visibility: 'public',
    urlSecret: '__path__=/chat/abc',
  });
  await createAppViaAdmin({
    id: 'querysecret',
    name: 'query 凭据',
    upstream: `http://127.0.0.1:${upPort}`,
    visibility: 'public',
    urlSecret: 'token=SECRET123',
  });
}, 30_000);

afterAll(async () => {
  await new Promise<void>((r) => gw.close(() => r()));
  await new Promise<void>((r) => up.close(() => r()));
  closeDb();
  teardownTestDb(dir);
});

describe('W5 反代（B1）', () => {
  it('裸 /app/<id> 301 补斜杠', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/pub`, { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/app/pub/');
  });

  it('HTML 改写：绝对路径进代理前缀 + base 注入 + 猴补丁 + Link 头', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/pub/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/app/pub/assets/style.css"');
    expect(html).toContain('src="/app/pub/img.png"');
    expect(html).toContain('/app/pub/img@2x.png 2x');
    expect(html).toContain('href="/app/pub/page"');
    expect(html).toContain('<base href="/app/pub/">');
    expect(html).toContain('var PREFIX="/app/pub"');
    expect(res.headers.get('link')).toContain('/app/pub/assets/preload.css');
  });

  it('资源映射到上游根 + 请求头过滤（cookie/authorization 不外泄）', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/pub/up?a=1`, {
      headers: { cookie: 'aap_sid=should-not-leak', authorization: 'Bearer x' },
    });
    const body = (await res.json()) as { url: string; headers: Record<string, string> };
    expect(body.url).toBe('/up?a=1');
    expect(body.headers.cookie).toBeUndefined();
    expect(body.headers.authorization).toBeUndefined();
    expect(body.headers.host).toBe(`127.0.0.1:${upPort}`);
  });

  it('身份注入（passUser）：签名可验签、aud 正确', async () => {
    // 登录普通用户
    const base = `http://127.0.0.1:${gwPort}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'freeuser', password: 'free-password' }),
    });
    const cookie = cookieOf(login);
    const res = await fetch(`${base}/app/pub/up`, { headers: { cookie } });
    const body = (await res.json()) as { headers: Record<string, string> };
    const payload = body.headers['x-aap-identity'];
    const sig = body.headers['x-aap-identity-sig'];
    expect(payload).toBeTruthy();
    const secret = getSetting('AAP_SIGN_SECRET')!;
    const v = verifyIdentity(payload!, sig!, secret, 'pub');
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload.uid).toBeTruthy();
      expect(v.payload.kind).toBe('local');
    }
  });

  it('Location 仅同源改写', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/pub/redir`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/pub/landing');
  });

  it('SSE 流式透传（text/event-stream 原样，无 HTML 改写）', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/pub/sse`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: one');
    expect(text).toContain('data: two');
  });

  it('urlSecret：query 型注入 + 请求侧优先合并；path 型替换上游路径', async () => {
    const base = `http://127.0.0.1:${gwPort}`;
    const qs = await fetch(`${base}/app/querysecret/up?x=1`);
    const qsBody = (await qs.json()) as { url: string };
    expect(qsBody.url).toContain('token=SECRET123');
    expect(qsBody.url).toContain('x=1');

    const ps = await fetch(`${base}/app/pathsecret/up`);
    const psBody = (await ps.json()) as { url: string };
    expect(psBody.url.startsWith('/chat/abc/up')).toBe(true);
  });

  it('路径穿越（编码变体）拒绝（不落 200 即安全）', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/pub/%2e%2e/secret`);
    expect(res.status).not.toBe(200);
  });
});

describe('W5 访问策略（B4 三态）', () => {
  it('public 匿名可访问；login 匿名 403 提示登录', async () => {
    const pub = await fetch(`http://127.0.0.1:${gwPort}/app/pub/`);
    expect(pub.status).toBe(200);

    const priv = await fetch(`http://127.0.0.1:${gwPort}/app/priv/`);
    expect(priv.status).toBe(403);
    expect(await priv.text()).toContain('需要登录');
  });

  it('restricted 应用：非 ACL 用户 403', async () => {
    const base = `http://127.0.0.1:${gwPort}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'freeuser', password: 'free-password' }),
    });
    const cookie = cookieOf(login);
    const res = await fetch(`${base}/app/vip/`, { headers: { cookie } });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('未对你');
  });

  it('卡片墙：accessible 标记按会话计算', async () => {
    const anon = await fetch(`http://127.0.0.1:${gwPort}/api/apps`);
    const anonBody = (await anon.json()) as { apps: Array<{ id: string; accessible: boolean }> };
    const pubCard = anonBody.apps.find((a) => a.id === 'pub');
    const privCard = anonBody.apps.find((a) => a.id === 'priv');
    expect(pubCard?.accessible).toBe(true);
    expect(privCard?.accessible).toBe(false);
  });
});

describe('W5 WebSocket（B2）', () => {
  it('经网关 upgrade 的回声（HTTP）', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/app/pub/echo`);
    const received = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 5000);
      ws.on('open', () => ws.send('hello'));
      ws.on('message', (data) => {
        clearTimeout(t);
        resolve(data.toString());
      });
      ws.on('error', reject);
    });
    expect(received).toBe('echo:hello');
    ws.close();
  });

  it('未授权 WS（login 应用）被拒', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/app/priv/echo`);
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('error', (e) => resolve(e.message));
      ws.on('unexpected-server-response', (res) => resolve(`status:${res.statusCode}`));
    });
    expect(outcome).not.toBe('open');
    ws.close();
  });
});

describe('P 可见性新模型（restricted/private/分组）', () => {
  it('restricted + ACL：指定账号可见、其它登录用户不可见；private 仅归属者', async () => {
    const base = `http://127.0.0.1:${gwPort}`;
    // 直插分组/成员/ACL（走 DB，管理 API 已在别处覆盖）
    const { getDb } = await import('../db/index.js');
    const { userGroups, userGroupMembers, appAcl, apps } = await import('../db/schema.js');
    const now = Date.now();
    const g = getDb().insert(userGroups).values({ name: 'vip-test', createdAt: now }).run();
    const gid = Number(g.lastInsertRowid);
    // 建两个测试用户
    const u1 = getDb().insert(users).values({ kind: 'local', username: 'aclvip', role: 'user', createdAt: now }).run();
    const u1id = Number(u1.lastInsertRowid);
    const u2 = getDb().insert(users).values({ kind: 'local', username: 'aclnone', role: 'user', createdAt: now }).run();
    const u2id = Number(u2.lastInsertRowid);
    getDb().insert(userGroupMembers).values({ groupId: gid, userId: u1id, createdAt: now }).run();
    // restricted 应用：仅 gid 组可见
    getDb().insert(apps).values({
      id: 'acl-app', name: 'ACL', visibility: 'restricted', upstream: `http://127.0.0.1:${upPort}`,
      ownerUserId: 1, kind: 'upstream', createdAt: now, updatedAt: now,
    }).run();
    getDb().insert(appAcl).values({ appId: 'acl-app', allowGroupIds: JSON.stringify([gid]), allowUserIds: '[]' }).run();
    // private 应用：归属 u1
    getDb().insert(apps).values({
      id: 'priv-app', name: 'PRIV', visibility: 'private', upstream: `http://127.0.0.1:${upPort}`,
      ownerUserId: u1id, kind: 'upstream', createdAt: now, updatedAt: now,
    }).run();

    const login = async (username: string): Promise<string> => {
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ username, password: 'x' }),
      });
      void r;
      return '';
    };
    void login;

    // aclvip 登录 → restricted 可访问；priv（归属他人）403
    const pw = 'acl-password';
    const { writeLocalCredentials } = await import('../lib/bootstrap.js');
    await writeLocalCredentials(u1id, pw);
    await writeLocalCredentials(u2id, pw);
    const l1 = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'aclvip', password: pw }),
    });
    const c1 = cookieOf(l1);
    expect((await fetch(`${base}/app/acl-app/`, { headers: { cookie: c1 } })).status).toBe(200);
    // aclvip 是 priv-app 归属者 → 自己可见
    expect((await fetch(`${base}/app/priv-app/`, { headers: { cookie: c1 } })).status).toBe(200);

    const l2 = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'aclnone', password: pw }),
    });
    const c2 = cookieOf(l2);
    expect((await fetch(`${base}/app/acl-app/`, { headers: { cookie: c2 } })).status).toBe(403);
    // 非归属者 → private 403
    expect((await fetch(`${base}/app/priv-app/`, { headers: { cookie: c2 } })).status).toBe(403);
    void u2id;
  });

  it('HTML 托管应用 + 统一页面元素注入', async () => {
    const base = `http://127.0.0.1:${gwPort}`;
    const { writeHtmlApp } = await import('../gateway/staticApp.js');
    const { apps } = await import('../db/schema.js');
    writeHtmlApp('htmltest', '<!doctype html><html><body><h1 id="h">HELLO-HTML</h1></body></html>');
    getDb().insert(apps).values({
      id: 'htmltest', name: 'HTML', visibility: 'public', upstream: '', kind: 'html',
      ownerUserId: 1, createdAt: Date.now(), updatedAt: Date.now(),
    }).run();
    const res = await fetch(`${base}/app/htmltest/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('HELLO-HTML');
    expect(html).toContain('/portal-chrome.js');
    const chrome = await fetch(`${base}/portal-chrome.js`);
    expect((await chrome.text())).toContain('应用门户');
  });
});

describe('W5 限流（令牌桶双维度）', () => {
  it('超过每 IP 上限 → 429（放最后，避免污染其他用例）', async () => {
    setSetting('RATE_IP_PER_MIN', '3');
    // 连续请求匿名公开应用，直到 429（桶里可能已有余量，上限 20 次防死循环）
    let got429 = false;
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`http://127.0.0.1:${gwPort}/app/pub/up`);
      if (res.status === 429) {
        got429 = true;
        break;
      }
      await res.text();
    }
    expect(got429).toBe(true);
    setSetting('RATE_IP_PER_MIN', '600');
  });
});
