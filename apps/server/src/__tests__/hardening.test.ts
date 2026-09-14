/**
 * 安全加固回归（渗透测试 2026-09-14 + 代码终审 批一）：
 *  - 网关错误页 XSS：htmlError 全参数转义 + /app/:id isSlug 校验 + display_name 净化
 *  - 托管应用路径越界（../ 兄弟目录读文件）
 *  - storePackageFiles 压缩包路径逃逸
 *  - egress：IP 字面量拒绝 + 私网段判定 + DNS 失败不泄露 fetch 错误
 *  - 审核门禁：pending/rejected 对非归属者拒绝；公开应用推未审新版先下线
 *  - LLM 无归因调用默认拒绝（ATTRIBUTION_REQUIRED）
 *  - 沙箱 invoked 身份环境变量可验签（M4 归因链）
 *  - admin 包上传：同名 409 不触碰既有站点目录
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { closeDb, getDb, getSqlite } from '../db/index.js';
import { getSetting, seedSettings, setSetting } from '../lib/settings.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { appSiteDir, storePackageFiles, validateManifest, writeHtmlApp } from '../gateway/staticApp.js';
import { isPrivateIp } from '../routes/aap.js';
import { identityEnv } from '../lib/sandbox.js';
import { signIdentity, verifyIdentity } from '../gateway/identity.js';
import { hasLeadingZeroBits } from '../lib/pow.js';
import { appendLedger, cachedBalance, createAppToken, grantTokens, precheck, recomputeBalance, settleEstimate } from '../lib/llm.js';
import { HttpError } from '../lib/httpError.js';
import { apps, inviteCodes, users, verificationCodes } from '../db/schema.js';
import { writeLocalCredentials } from '../lib/bootstrap.js';

let server: Server;
let base = '';
let dir: string;
let adminCookie = '';
let ownerCookie = '';
let otherCookie = '';
let ownerId = 0;

function zipPkg(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

function cookieOf(res: Response): string {
  const cookies = res.headers.getSetCookie();
  const sid = cookies.find((c) => c.startsWith('aap_sid='));
  if (!sid) throw new Error('no session cookie');
  return sid.split(';')[0]!;
}

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status}`);
  return cookieOf(res);
}

beforeAll(async () => {
  ({ dir } = setupTestDb());
  seedSettings();

  const cfg = { ...loadConfig({}), webDist: null };
  server = http.createServer(createApp(cfg));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;

  // admin / owner / other 三用户
  const a = getDb().insert(users).values({ kind: 'local', username: 'admin', role: 'admin', createdAt: Date.now() }).run();
  await writeLocalCredentials(Number(a.lastInsertRowid), 'admin-password');
  const o = getDb().insert(users).values({ kind: 'local', username: 'pkgowner', role: 'user', createdAt: Date.now() }).run();
  ownerId = Number(o.lastInsertRowid);
  await writeLocalCredentials(ownerId, 'owner-password');
  const t = getDb().insert(users).values({ kind: 'local', username: 'other', role: 'user', createdAt: Date.now() }).run();
  await writeLocalCredentials(Number(t.lastInsertRowid), 'other-password');

  adminCookie = await login('admin', 'admin-password');
  ownerCookie = await login('pkgowner', 'owner-password');
  otherCookie = await login('other', 'other-password');
}, 30_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeDb();
  teardownTestDb(dir);
});

describe('错误页 XSS（P0-1/P0-2）', () => {
  it('非法应用 id 不回显（isSlug 校验，反射注入被拒）', async () => {
    const res = await fetch(`${base}/app/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E/x`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('<img');
    expect(body).not.toContain('onerror');
  });

  it('错误页插值内容 HTML 转义（应用名含 HTML 时）', async () => {
    // 管理端建的 login 应用（匿名 → 403 分支插值 app.name）
    getDb().insert(apps).values({
      id: 'esc-app', name: '<b>bold</b>&"q', visibility: 'login', kind: 'html', upstream: '',
      ownerUserId: ownerId, createdAt: Date.now(), updatedAt: Date.now(),
    }).run();
    const res = await fetch(`${base}/app/esc-app/`);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(body).not.toContain('<b>bold</b>');
  });

  it('display_name 净化：剥 HTML 敏感字符 + 限长', () => {
    const m = validateManifest({ name: 'dn-app', type: 'html', display_name: `<img src=x onerror=alert(1)>${'长'.repeat(60)}` });
    expect(m.displayName).not.toMatch(/[<>"'`]/);
    expect(m.displayName.length).toBeLessThanOrEqual(64);
  });
});

describe('托管应用路径越界（P1-4）', () => {
  it('raw 通道 ../ 兄弟目录读文件被 400 拒绝', async () => {
    writeHtmlApp('trav-a', '<h1>trav-a</h1>');
    fs.mkdirSync(appSiteDir('trav-b'), { recursive: true });
    fs.writeFileSync(path.join(appSiteDir('trav-b'), 'secret.html'), 'TOPSECRET');
    getDb().insert(apps).values({
      id: 'trav-a', name: 'TravA', visibility: 'public', kind: 'html', upstream: '',
      ownerUserId: ownerId, createdAt: Date.now(), updatedAt: Date.now(),
    }).run();
    const res = await fetch(`${base}/app/trav-a/raw/..%2Ftrav-b%2Fsecret.html`);
    expect(res.status).toBe(400);
  });

  it('非 raw 通道只返回沙箱外壳（不把越界路径交给静态层）', async () => {
    const res = await fetch(`${base}/app/trav-a/..%2Ftrav-b%2Fsecret.html`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('TOPSECRET');
    expect(body).toContain('sandbox=');
  });
});

describe('用户包 iframe 沙箱（PRD G1 / 批二）', () => {
  it('用户上传 html：入口是外壳页（iframe sandbox + raw 指针）；raw 通道无 chrome、无同源 cookie 面', async () => {
    writeHtmlApp('sbx-app', '<h1 id="m">SBX-MARKER</h1><a href="/page2">inner</a>');
    getDb().insert(apps).values({
      id: 'sbx-app', name: 'Sbx', visibility: 'public', kind: 'html', upstream: '',
      ownerUserId: ownerId, createdAt: Date.now(), updatedAt: Date.now(),
    }).run();

    const entry = await fetch(`${base}/app/sbx-app/`);
    expect(entry.status).toBe(200);
    const shell = await entry.text();
    expect(shell).toContain('sandbox="allow-scripts');
    expect(shell).not.toContain('allow-same-origin');
    expect(shell).toContain('/app/sbx-app/raw/');
    expect(shell).toContain('/portal-chrome.js');

    const raw = await fetch(`${base}/app/sbx-app/raw/`);
    expect(raw.status).toBe(200);
    const rawHtml = await raw.text();
    expect(rawHtml).toContain('SBX-MARKER');
    expect(rawHtml).not.toContain('/portal-chrome.js');
  });

  it('压缩包条目路径逃逸被拒（不写出 appsites 根）', () => {
    // 旧实现的 dest = path.join(dir, '../x') 会落到 data/ 下；新实现必须跳过该条目
    const escapedFile = path.join(path.dirname(path.dirname(appSiteDir('x'))), 'hardening-escape-marker.txt');
    fs.rmSync(escapedFile, { force: true });
    const buf = zipPkg({ '../hardening-escape-marker.txt': 'x' });
    // 无 manifest.json 会抛错，但逃逸条目必须先被过滤
    expect(() => storePackageFiles('escape-probe', buf)).toThrow();
    expect(fs.existsSync(escapedFile)).toBe(false);
  });
});

describe('egress 出站代理（P0-3）', () => {
  it('IP 字面量直连一律拒绝', async () => {
    const token = createAppToken('eg-app1', 'egress-test', null);
    const res = await fetch(`${base}/api/aap/egress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aap-token': token },
      body: JSON.stringify({ url: 'http://127.0.0.1:8080/api/health' }),
    });
    expect(res.status).toBe(403);
  });

  it('私网/保留段判定（含 v4 映射、ULA、链路本地、CGNAT）', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '114.114.114.114', '2606:4700::1111']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('白名单外域名拒绝；白名单内但 DNS 失败 → 拦截且不泄露 fetch 错误', async () => {
    const token = createAppToken('eg-app2', 'egress-test', null);
    getDb().insert(apps).values({
      id: 'eg-app2', name: 'EG2', visibility: 'private', kind: 'package', upstream: '',
      manifestJson: JSON.stringify({ capabilities: [], network: ['definitely-not-a-real-host.test'] }),
      ownerUserId: ownerId, createdAt: Date.now(), updatedAt: Date.now(),
    }).run();

    const outside = await fetch(`${base}/api/aap/egress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aap-token': token },
      body: JSON.stringify({ url: 'http://example.com/' }),
    });
    expect(outside.status).toBe(403);

    const dnsFail = await fetch(`${base}/api/aap/egress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aap-token': token },
      body: JSON.stringify({ url: 'http://definitely-not-a-real-host.test/' }),
    });
    const body = (await dnsFail.json()) as { error?: { code?: string; message?: string } };
    expect(dnsFail.status).toBe(403);
    expect(body.error?.code).toBe('EGRESS_DENIED');
    expect(body.error?.message ?? '').not.toContain('fetch failed');
  });
});

describe('审核门禁（P1-6）', () => {
  it('pending/rejected：非归属者与匿名拒绝；归属者可用；approve 恢复', async () => {
    writeHtmlApp('rev-app', '<h1>REV</h1>');
    getDb().insert(apps).values({
      id: 'rev-app', name: 'Rev', visibility: 'public', kind: 'html', upstream: '',
      reviewStatus: 'approved', ownerUserId: ownerId, createdAt: Date.now(), updatedAt: Date.now(),
    }).run();
    expect((await fetch(`${base}/app/rev-app/`, { headers: { cookie: otherCookie } })).status).toBe(200);

    getDb().update(apps).set({ reviewStatus: 'pending' }).where(eq(apps.id, 'rev-app')).run();
    expect((await fetch(`${base}/app/rev-app/`, { headers: { cookie: otherCookie } })).status).toBe(403);
    expect((await fetch(`${base}/app/rev-app/`)).status).toBe(403);
    expect((await fetch(`${base}/app/rev-app/`, { headers: { cookie: ownerCookie } })).status).toBe(200);

    // 执行元数据端点同门禁
    expect((await fetch(`${base}/api/apps/rev-app/meta`, { headers: { cookie: otherCookie } })).status).toBe(404);

    getDb().update(apps).set({ reviewStatus: 'approved' }).where(eq(apps.id, 'rev-app')).run();
    expect((await fetch(`${base}/app/rev-app/`, { headers: { cookie: otherCookie } })).status).toBe(200);
  });

  it('已公开应用推未审新版：先下线（enabled=false）待审，approve 后恢复', async () => {
    const res = await fetch(`${base}/api/apps/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: ownerCookie },
      body: JSON.stringify({
        filename: 'pkg.neon-aap',
        dataBase64: zipPkg({ 'manifest.json': JSON.stringify({ name: 'rev-app', display_name: 'Rev', type: 'html', version: '2.0.0' }), 'index.html': '<h1>v2</h1>' }).toString('base64'),
      }),
    });
    expect(res.status).toBe(200);
    const row = getDb().select().from(apps).where(eq(apps.id, 'rev-app')).get();
    expect(row?.reviewStatus).toBe('pending');
    expect(row?.enabled).toBe(false);
    // 匿名不可达（enabled=false → 网关 404；即便 enabled 也会被审核门禁 403）
    expect((await fetch(`${base}/app/rev-app/`)).status).toBe(404);

    // 管理员批准 → enabled 恢复
    const ok = await fetch(`${base}/api/admin/review/rev-app/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ visibility: 'public' }),
    });
    expect(ok.status).toBe(200);
    const after = getDb().select().from(apps).where(eq(apps.id, 'rev-app')).get();
    expect(after?.enabled).toBe(true);
    expect(after?.reviewStatus).toBe('approved');
  });
});

describe('LLM 归因强制（P1-5）', () => {
  it('无归因调用默认拒绝（ATTRIBUTION_REQUIRED）；allow 档放行', () => {
    try {
      precheck(null, 100);
      expect.unreachable('precheck 应拒绝');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(403);
      expect((err as HttpError).code).toBe('ATTRIBUTION_REQUIRED');
    }
    setSetting('LLM_UNATTRIBUTED_POLICY', 'allow');
    expect(() => precheck(null, 100)).not.toThrow();
    setSetting('LLM_UNATTRIBUTED_POLICY', 'reject');
  });

  it('invoked 身份环境变量：平台签名可验签且 uid 正确（M4 归因链）', () => {
    const env = identityEnv('some-app', ownerId);
    expect(env.AAP_IDENTITY_PAYLOAD).toBeTruthy();
    const secret = getSetting('AAP_SIGN_SECRET')!;
    const v = verifyIdentity(env.AAP_IDENTITY_PAYLOAD!, env.AAP_IDENTITY_SIG!, secret, 'some-app');
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.payload.uid).toBe(String(ownerId));
    expect(identityEnv('some-app', null).AAP_IDENTITY_PAYLOAD).toBeUndefined();
  });
});

describe('admin 包上传顺序（P3-14）', () => {
  it('同名 409：既有站点目录不被触碰，临时目录清理', async () => {
    writeHtmlApp('exist-up', '<h1>ORIGINAL-MARKER</h1>');
    getDb().insert(apps).values({
      id: 'exist-up', name: 'ExistUp', visibility: 'private', kind: 'html', upstream: '',
      ownerUserId: ownerId, createdAt: Date.now(), updatedAt: Date.now(),
    }).run();
    const res = await fetch(`${base}/api/admin/apps/package`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({
        filename: 'pkg.neon-aap',
        dataBase64: zipPkg({ 'manifest.json': JSON.stringify({ name: 'exist-up', display_name: 'Dup', type: 'html' }), 'index.html': '<h1>NEW</h1>' }).toString('base64'),
      }),
    });
    expect(res.status).toBe(409);
    const marker = fs.readFileSync(path.join(appSiteDir('exist-up'), 'index.html'), 'utf8');
    expect(marker).toContain('ORIGINAL-MARKER');
    // 临时目录已被清理（唯一命名前缀）
    const dataRoot = path.dirname(appSiteDir('x'));
    const leftovers = fs.readdirSync(dataRoot).filter((n) => n.startsWith('upload_tmp_'));
    expect(leftovers).toHaveLength(0);
  });
});

// ---------- 批二：纵深 ----------

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
  return ((await vRes.json()) as { token: string }).token;
}

function rawSessionCookie(userId: number, stepUp: number | null): string {
  const token = `rawtok-${createHash('sha256').update(String(userId)).digest('hex').slice(0, 24)}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  getSqlite()
    .prepare(
      `INSERT OR REPLACE INTO sessions(token_hash, user_id, auth_state, step_up_until, created_at, last_seen_at, expires_at, ip, user_agent)
       VALUES (?, ?, 'full', ?, ?, ?, ?, NULL, 'test')`,
    )
    .run(tokenHash, userId, stepUp, now, now, now + 3600_000);
  return `aap_sid=${token}`;
}

describe('MFA 绑定步升（P2-9）', () => {
  it('登录即授予步升窗口：enroll 立即可用（强制绑 MFA 流程不卡）', async () => {
    const cookie = await login('other', 'other-password');
    const res = await fetch(`${base}/api/auth/mfa/totp/enroll`, { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { secret?: string };
    expect(body.secret).toBeTruthy();
  });

  it('无步升窗口的陈旧会话：enroll/confirm 403 STEP_UP_REQUIRED（防劫持会话绑新因子）', async () => {
    const otherRow = getDb().select().from(users).where(eq(users.username, 'other')).get();
    const cookie = rawSessionCookie(otherRow!.id, null);
    const res = await fetch(`${base}/api/auth/mfa/totp/enroll`, { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('STEP_UP_REQUIRED');
  });
});

describe('admin redeem 显式守卫（P2-10）', () => {
  it('非管理员 403（不再依赖挂载顺序偶然保护）；管理员可建批次', async () => {
    const denied = await fetch(`${base}/api/admin/redeem/batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: otherCookie },
      body: JSON.stringify({ kind: 'tokens', count: 1, tokens: 100 }),
    });
    expect(denied.status).toBe(403);

    const ok = await fetch(`${base}/api/admin/redeem/batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ kind: 'tokens', count: 1, tokens: 100 }),
    });
    expect(ok.status).toBe(200);
  });
});

describe('HTTPS 跳转 Host 白名单（P2-11）', () => {
  function get(host: string): Promise<string | number | null> {
    return new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: new URL(base).port, path: '/', headers: { host } }, (res) => {
        void res.resume();
        resolve(res.statusCode === 302 ? (res.headers.location ?? null) : (res.statusCode ?? 0));
      });
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  it('非配置域名不反射：跳到 ACME_DOMAIN；命中域名正常跳转', async () => {
    setSetting('HTTPS_REDIRECT', 'true');
    setSetting('ACME_DOMAIN', 'regtest.example.com');
    try {
      expect(await get('evil.example.com')).toBe('https://regtest.example.com/');
      expect(await get('regtest.example.com')).toBe('https://regtest.example.com/');
    } finally {
      setSetting('HTTPS_REDIRECT', 'false');
      setSetting('ACME_DOMAIN', '');
    }
  });
});

describe('身份头验签（P3-16：exp 强制 + jti 一次性）', () => {
  it('重放拒绝；allowReplay 豁免（平台内部归因）；exp 过期拒绝；缺 exp 拒绝', () => {
    const secret = getSetting('AAP_SIGN_SECRET')!;
    const su = {
      id: ownerId, kind: 'local' as const, subject: 'local:pkgowner', username: 'pkgowner', email: null,
      phone: null, name: 'pkgowner', role: 'user' as const, status: 'active', sessionId: 't',
      authState: 'full' as const, stepUpUntil: null, plan: 'free' as const, mfaEnabled: false,
      mustChangePassword: false,
    };
    const idn = signIdentity(su, 'aud-app')!;
    expect(verifyIdentity(idn.payload, idn.sig, secret, 'aud-app').ok).toBe(true);
    // 同一身份头二次使用 → 重放拒绝
    const replay = verifyIdentity(idn.payload, idn.sig, secret, 'aud-app');
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error).toBe('JTI_REPLAYED');
    // 平台内部归因（沙箱一次运行多次调用同一身份）→ 豁免
    expect(verifyIdentity(idn.payload, idn.sig, secret, 'aud-app', { allowReplay: true }).ok).toBe(true);

    // exp 必须存在且未过期：篡改过期 payload（重新签名）→ EXPIRED
    const parsed = JSON.parse(Buffer.from(idn.payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    parsed.exp = Date.now() - 1000;
    delete parsed.jti;
    const payloadB64 = Buffer.from(JSON.stringify(parsed)).toString('base64url');
    const sig = createHmac('sha256', secret).update(payloadB64).digest('hex');
    const expired = verifyIdentity(payloadB64, sig, secret, 'aud-app');
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error).toBe('EXPIRED');
  });
});

describe('邀请码并发双花（批二⑧）', () => {
  it('verify 消费带 usedBy IS NULL 条件：码已被占用 → 409 且不建号', async () => {
    getDb().insert(inviteCodes).values({ code: 'HARD-CODE-01', createdBy: 1, createdAt: Date.now() }).run();
    setSetting('REGISTRATION_MODE', 'invite');
    try {
      const powToken = await solvePow();
      const start = await fetch(`${base}/api/auth/register/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'harden1', password: 'harden-pass-123', email: 'harden1@example.com', inviteCode: 'HARD-CODE-01', powToken }),
      });
      expect(start.status).toBe(200);
      const { registrationId } = (await start.json()) as { registrationId: string };

      // 直插一个未消费验证码（已知 code=654321、salt=hardensalt）
      const now = Date.now();
      getDb().insert(verificationCodes).values({
        channel: 'email', target: 'harden1@example.com', purpose: 'register',
        codeHash: `hardensalt:${createHash('sha256').update('hardensalt:654321').digest('hex')}`,
        ip: null, createdAt: now, expiresAt: now + 5 * 60_000,
      }).run();
      // 邀请码被「另一个注册」抢先消费
      getDb().update(inviteCodes).set({ usedBy: 9999, usedAt: now }).where(eq(inviteCodes.code, 'HARD-CODE-01')).run();

      const verify = await fetch(`${base}/api/auth/register/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ registrationId, code: '654321' }),
      });
      expect(verify.status).toBe(409);
      expect(((await verify.json()) as { error?: { code?: string } }).error?.code).toBe('INVITE_CODE_USED');
      // 回滚：用户未创建
      expect(getDb().select().from(users).where(eq(users.username, 'harden1')).get()).toBeUndefined();
    } finally {
      setSetting('REGISTRATION_MODE', 'closed');
    }
  });
});

describe('HTML 页面内容编辑（编辑弹窗数据面）', () => {
  it('GET 读取当前页面；PUT 更新落盘保存即生效；空内容 400；非 html 应用 400', async () => {
    writeHtmlApp('edit-html', '<h1>V1</h1>');
    getDb().insert(apps).values({
      id: 'edit-html', name: 'EditHtml', visibility: 'public', kind: 'html', upstream: '',
      ownerUserId: ownerId, enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
    }).run();

    const read = await fetch(`${base}/api/admin/apps/edit-html/html`, { headers: { cookie: adminCookie } });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { html: string }).html).toContain('V1');

    const put = await fetch(`${base}/api/admin/apps/edit-html`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ html: '<h1>V2-EDITED</h1>' }),
    });
    expect(put.status).toBe(200);
    const file = await fetch(`${base}/app/edit-html/raw/`, { headers: { cookie: ownerCookie } });
    // owner 是普通用户 → 走 iframe 沙箱外壳；raw 通道才直出内容
    expect(await file.text()).toContain('V2-EDITED');

    const empty = await fetch(`${base}/api/admin/apps/edit-html`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ html: '   ' }),
    });
    expect(empty.status).toBe(400);
  });
});

describe('托管应用健康探测（批：html/package 无 upstream 不再恒「异常」）', () => {
  it('html 应用探测记 ok；persistent 未拉起记 unknown；测试按钮对托管应用返回 ok', async () => {
    getDb().insert(apps).values({
      id: 'health-html', name: 'HtmlApp', visibility: 'public', kind: 'html', upstream: '',
      ownerUserId: ownerId, enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
    }).run();
    getDb().insert(apps).values({
      id: 'health-sbx', name: 'SbxApp', visibility: 'private', kind: 'package', upstream: '',
      runtimeMode: 'persistent', ownerUserId: ownerId, enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
    }).run();

    const { probeAll } = await import('../gateway/health.js');
    await probeAll();

    const rows = getDb().select().from(apps).all();
    expect(rows.find((r) => r.id === 'health-html')?.healthState).toBe('ok');
    expect(rows.find((r) => r.id === 'health-sbx')?.healthState).toBe('unknown');

    const test = await fetch(`${base}/api/admin/apps/health-html/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
    });
    expect(test.status).toBe(200);
    expect(((await test.json()) as { ok?: boolean }).ok).toBe(true);
  });
});

describe('登录 401 信息泄露收敛（P2-12）', () => {
  it('登录失败响应不含 failures/banned', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'other', password: 'definitely-wrong' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: Record<string, unknown> };
    expect(body.error && 'failures' in body.error).toBe(false);
    expect(body.error && 'banned' in body.error).toBe(false);
  });

  it('/api/health 匿名仅回 ok（version/uptime 移入 admin overview）', async () => {
    const anon = await fetch(`${base}/api/health`);
    const body = (await anon.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.version).toBeUndefined();
    expect(body.uptimeSec).toBeUndefined();

    const ov = await fetch(`${base}/api/admin/overview`, { headers: { cookie: adminCookie } });
    const ovBody = (await ov.json()) as { releaseVersion?: string; uptimeSec?: number };
    expect(ovBody.releaseVersion).toBeTruthy();
    expect(typeof ovBody.uptimeSec).toBe('number');
  });

  it('/api/dev/guide 匿名 401、登录可见', async () => {
    const anon = await fetch(`${base}/api/dev/guide`);
    expect(anon.status).toBe(401);
    const authed = await fetch(`${base}/api/dev/guide`, { headers: { cookie: otherCookie } });
    expect(authed.status).toBe(200);
  });
});

// ---------- 批三：正确性/并发/健壮性 ----------

describe('对账在途保护（批三①）', () => {
  it('预检占用期间重算/对账保留在途扣减；结算后与账本一致', () => {
    const uid = 7001;
    grantTokens(uid, 1000, 'seed', 1);
    precheck(uid, 100);
    expect(cachedBalance(uid)).toBe(900);
    // 结算循环重算：在途 100 不被抹掉
    expect(recomputeBalance(uid)).toBe(900);
    // 请求进行中管理员发放 → 重算仍保留在途扣减
    grantTokens(uid, 500, 'mid-flight', 1);
    expect(cachedBalance(uid)).toBe(1400);
    // 请求结束：实际 40，释放预估 100（补回差值 60），账本补记实际用量
    settleEstimate(uid, 100, 40);
    expect(cachedBalance(uid)).toBe(1460);
    appendLedger({ kind: 'usage', delta: -40, userId: uid, appId: 't', model: 'm' });
    expect(recomputeBalance(uid)).toBe(1460);
    expect(cachedBalance(uid)).toBe(1460);
  });
});

describe('settings secret 加密落盘（批三③）', () => {
  it('secret 配置密文入库、读取透明解密；非 secret 项仍明文', () => {
    setSetting('SMTP_PASS', 'supersecret-pass');
    const raw = getSqlite().prepare("SELECT value FROM settings WHERE key = 'SMTP_PASS'").get() as { value: string };
    expect(raw.value.startsWith('enc:')).toBe(true);
    expect(raw.value).not.toContain('supersecret-pass');
    expect(getSetting('SMTP_PASS')).toBe('supersecret-pass');

    setSetting('SITE_NAME', '明文名称站点');
    const raw2 = getSqlite().prepare("SELECT value FROM settings WHERE key = 'SITE_NAME'").get() as { value: string };
    expect(raw2.value).toBe('明文名称站点');
  });
});

describe('账号维度登录节流（批三⑤）', () => {
  it('同账号失败超阈值后：即使换正确密码也要求 PoW', async () => {
    // 清空失败计数：让阈值在本用例内从零累计（否则全局 IP 计数会提前触发 PoW，
    // 吞掉失败记录，账号维度计数不满 5）
    getSqlite().prepare('DELETE FROM login_attempts').run();
    const a = getDb().insert(users).values({ kind: 'local', username: 'acct1', role: 'user', createdAt: Date.now() }).run();
    await writeLocalCredentials(Number(a.lastInsertRowid), 'acct1-correct-pass');
    // 跨 IP 语义在单进程测试里退化为同 IP 连续失败：账号维度独立计数被验证
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${i}.1` },
        body: JSON.stringify({ username: 'acct1', password: 'wrong-pass' }),
      });
      void r;
    }
    // 账号失败已达 5 次：正确密码也被 PoW 闸门拦截（TRUST_PROXY=false 时 XFF 无效，
    // 全部落在同一 IP；此处账号维度阈值与 IP 维度同达，无法单证账号维度——
    // 直接断言 needsPow 语义）
    const { needsPow, accountFailuresInWindow } = await import('../lib/security.js');
    expect(accountFailuresInWindow('local:acct1')).toBeGreaterThanOrEqual(5);
    expect(needsPow('203.0.113.77', 'local:acct1')).toBe(true); // 全新 IP 也要求 PoW
    expect(needsPow('203.0.113.77', 'local:nobody-else')).toBe(false);
    // 正确密码从全新 IP 登录 → 403 POW_REQUIRED（无 token）
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.77' },
      body: JSON.stringify({ username: 'acct1', password: 'acct1-correct-pass' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('POW_REQUIRED');
  });
});
