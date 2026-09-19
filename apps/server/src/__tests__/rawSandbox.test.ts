/**
 * raw 通道浏览器侧沙箱（P0 安全回归）：
 *  - 非管理员归属的 html 应用：raw 通道响应必须带 CSP sandbox（无 allow-same-origin），
 *    顶层直达 raw URL 时包代码被关进 opaque origin（此前裸奔执行可接管会话）
 *  - raw 判定锚定段边界：/app/<id>/rawfoo 不得当 raw 直出（走外壳页）
 *  - 管理员自建 html 应用保持既往信任行为（直出、不附加 sandbox CSP）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { closeDb, getDb } from '../db/index.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { users, apps } from '../db/schema.js';
import { writeHtmlApp } from '../gateway/staticApp.js';

let gw: Server;
let gwPort = 0;
let dir: string;

const USER_HTML = '<!doctype html><html><body><h1>USERRAW-INDEX</h1><script>void 0</script></body></html>';
const ADMIN_HTML = '<!doctype html><html><body><h1>ADMINRAW-INDEX</h1></body></html>';

beforeAll(async () => {
  ({ dir } = setupTestDb());

  const cfg = { ...loadConfig({}), webDist: null };
  gw = http.createServer(createApp(cfg));
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
  gwPort = (gw.address() as AddressInfo).port;

  // 管理员（id=1）与普通用户（html 包归属者，非管理员 → 触发 iframe 沙箱隔离）
  const now = Date.now();
  getDb().insert(users).values({ kind: 'local', username: 'admin', name: '管理员', role: 'admin', createdAt: now }).run();
  const u = getDb().insert(users).values({ kind: 'local', username: 'uploader', name: '上传者', role: 'user', createdAt: now }).run();
  const uploaderId = Number(u.lastInsertRowid);

  writeHtmlApp('usrhtml', USER_HTML);
  getDb().insert(apps).values({
    id: 'usrhtml', name: '用户HTML', visibility: 'public', upstream: '', kind: 'html',
    ownerUserId: uploaderId, createdAt: now, updatedAt: now,
  }).run();

  writeHtmlApp('admhtml', ADMIN_HTML);
  getDb().insert(apps).values({
    id: 'admhtml', name: '管理员HTML', visibility: 'public', upstream: '', kind: 'html',
    ownerUserId: 1, createdAt: now, updatedAt: now,
  }).run();
}, 30_000);

afterAll(async () => {
  await new Promise<void>((r) => gw.close(() => r()));
  closeDb();
  teardownTestDb(dir);
});

describe('raw 通道浏览器侧沙箱（P0）', () => {
  it('a. 顶层直达 /app/<id>/raw/index.html：200 且 CSP 含 sandbox 且不含 allow-same-origin', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/usrhtml/raw/index.html`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('sandbox');
    expect(csp).not.toContain('allow-same-origin');
    // raw 通道直出包内容（不注入门户 chrome——chrome 在外壳层）
    const html = await res.text();
    expect(html).toContain('USERRAW-INDEX');
    expect(html).not.toContain('/portal-chrome.js');
  });

  it('b. GET /app/<id>/ 返回外壳页（iframe sandbox 承载内容）', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/usrhtml/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<iframe sandbox');
    expect(html).toContain('/app/usrhtml/raw/');
    expect(html).not.toContain('USERRAW-INDEX');
  });

  it('c. /app/<id>/rawfoo 不当 raw 直出：返回外壳页（iframe src 指向 raw/rawfoo）', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/usrhtml/rawfoo`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<iframe sandbox');
    expect(html).toContain('/app/usrhtml/raw/rawfoo');
  });

  it('d. 管理员自建 html 应用：直出且不附加 sandbox CSP（既往信任行为不变）', async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/app/admhtml/index.html`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('ADMINRAW-INDEX');
    expect(html).not.toContain('<iframe sandbox');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain('sandbox');
  });
});
