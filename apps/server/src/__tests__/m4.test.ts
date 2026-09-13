/**
 * M4 生态测试（G2/G3/G4/G5）：
 * 包上传（manifest 校验）→ 私有可用 → invoked 沙箱执行（echo / 每包 SQLite / 白名单拒绝）
 * → 提交审核 → 管理员通过/驳回。
 * 依赖系统 python3（执行沙箱）。
 */
import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { closeDb, getDb } from '../db/index.js';
import { seedSettings } from '../lib/settings.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let gw: Server;
let base: string;
let dir: string;
let adminCookie = '';
let pythonOk = true;

function zipPkg(files: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer().toString('base64');
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
  try {
    execSync('python3 -c "print(1)"', { stdio: 'pipe' });
  } catch {
    pythonOk = false;
  }

  const cfg = { ...loadConfig({}), webDist: null };
  gw = createApp(cfg).listen(0, '127.0.0.1');
  await new Promise<void>((r) => gw!.once('listening', r));
  base = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;

  // 管理员登录
  getDb()
    .insert((await import('../db/schema.js')).users)
    .values({ kind: 'local', username: 'admin', name: '管理员', role: 'admin', createdAt: Date.now() })
    .run();
  const { writeLocalCredentials } = await import('../lib/bootstrap.js');
  const adminId = getDb().select().from((await import('../db/schema.js')).users).get()!.id;
  await writeLocalCredentials(adminId, 'admin-password');
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'admin', password: 'admin-password' }),
  });
  adminCookie = cookieOf(login);
});

afterAll(() => {
  gw.close();
  closeDb();
  teardownTestDb(dir);
});

describe.skipIf(!pythonOk)('M4 生态（Python 沙箱运行时）', () => {
  const ECHO_MOD = `
def handle(input, aap):
    aap.log.info("echo called")
    aap.db.execute("CREATE TABLE IF NOT EXISTS hits (n INTEGER)")
    aap.db.execute("INSERT INTO hits VALUES (1)")
    n = aap.db.query("SELECT COUNT(*) AS c FROM hits")[0]["c"]
    return {"echo": input.get("x", ""), "runs": n}
`;

  it('上传 python 包 → 私有可用 → invoked 执行回显（每包独立 SQLite 计数递增）', async () => {
    const dataBase64 = zipPkg({
      'manifest.json': JSON.stringify({
        name: 'hellotool',
        display_name: 'Hello 工具',
        version: '1.0.0',
        type: 'python',
        entry: 'mod.py',
        runtime: 'invoked',
        capabilities: [],
        network: [],
      }),
      'mod.py': ECHO_MOD,
    });

    const submit = await fetch(`${base}/api/apps/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ filename: 'hellotool.neon-aap', dataBase64 }),
    });
    expect(submit.status).toBe(200);

    // 入参 schema 未配置 → JSON 文本输入
    const meta = await fetch(`${base}/api/apps/hellotool/meta`, { headers: { cookie: adminCookie } });
    expect(meta.status).toBe(200);

    const r1 = await fetch(`${base}/api/apps/hellotool/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ input: { x: '你好' } }),
    });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { status: string; result: { echo: string; runs: number } };
    expect(b1.status).toBe('ok');
    expect(b1.result.echo).toBe('你好');
    expect(b1.result.runs).toBe(1);

    // 第二次执行：每包独立 SQLite 计数递增
    const r2 = await fetch(`${base}/api/apps/hellotool/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ input: { x: '再' } }),
    });
    const b2 = (await r2.json()) as { result: { runs: number } };
    expect(b2.result.runs).toBe(2);
  });

  it('白名单执行点：出站域名未声明 → 拒绝', async () => {
    const dataBase64 = zipPkg({
      'manifest.json': JSON.stringify({
        name: 'nosytool',
        display_name: 'Nosy',
        version: '1.0.0',
        type: 'python',
        entry: 'mod.py',
        runtime: 'invoked',
        capabilities: [],
        network: ['api.example.com'],
      }),
      'mod.py': `
def handle(input, aap):
    aap.http.fetch("https://other.org/data")
    return {"ok": True}
`,
    });
    const submit = await fetch(`${base}/api/apps/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ filename: 'nosytool.neon-aap', dataBase64 }),
    });
    expect(submit.status).toBe(200);

    const run = await fetch(`${base}/api/apps/nosytool/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ input: {} }),
    });
    const b = (await run.json()) as { status: string; error: string };
    expect(b.status).toBe('error');
    expect(b.error).toContain('白名单');
  });

  it('审核流：提交审核 → 驳回带理由 → 再提交 → 通过', async () => {
    // 提交审核
    const sub = await fetch(`${base}/api/apps/hellotool/submit-review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
    });
    expect(sub.status).toBe(200);

    // 管理端驳回
    const rej = await fetch(`${base}/api/admin/review/hellotool/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ note: '缺少使用说明' }),
    });
    expect(rej.status).toBe(200);

    // 再提交 → 通过（公开）
    await fetch(`${base}/api/apps/hellotool/submit-review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
    });
    const ok = await fetch(`${base}/api/admin/review/hellotool/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ visibility: 'public' }),
    });
    expect(ok.status).toBe(200);

    // 匿名可见（public）
    const anon = await fetch(`${base}/api/apps`);
    const apps = (await anon.json()) as { apps: Array<{ id: string; accessible: boolean }> };
    const t = apps.apps.find((a) => a.id === 'hellotool');
    expect(t?.accessible).toBe(true);
  });
});
