/**
 * 应用环境变量 / 机密测试（G6）：
 * manifest.env 声明校验（保留名/正则/上限）→ 配置 API（权限/掩码/pattern 校验）
 * → invoked 执行注入端到端（子进程 os.environ 读到配置值与 default）→ 必填缺配拦截。
 * 依赖系统 python3（执行沙箱）。
 */
import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import AdmZip from 'adm-zip';
import { createServer, type Server as HttpServer } from 'node:http';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { closeDb, getDb } from '../db/index.js';
import { seedSettings, setSetting } from '../lib/settings.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { validateManifest } from '../gateway/staticApp.js';
import { stopAllPersistent } from '../lib/sandbox.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let gw: Server;
let base: string;
let dir: string;
let adminCookie = '';
let userCookie = '';
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

const ENV_MOD = `
import os

def handle(input, aap):
    return {
        "key": os.environ.get("ANALYSIS_KEY", ""),
        "max_items": os.environ.get("MAX_ITEMS", ""),
    }
`;

const ENV_MANIFEST = {
  name: 'envtool',
  display_name: '环境变量测试包',
  version: '1.0.0',
  type: 'python',
  entry: 'mod.py',
  runtime: 'invoked',
  capabilities: [],
  network: [],
  env: {
    ANALYSIS_KEY: { required: true, secret: true, pattern: '^[A-Za-z0-9]{8,}$', description: '分析服务密钥' },
    MAX_ITEMS: { required: false, default: '50', description: '单次最大条数' },
  },
};

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

  // 管理员（将作为包归属者）+ 普通用户（测越权）
  const { users } = await import('../db/schema.js');
  const { writeLocalCredentials } = await import('../lib/bootstrap.js');
  getDb()
    .insert(users)
    .values({ kind: 'local', username: 'admin', name: '管理员', role: 'admin', createdAt: Date.now() })
    .run();
  const adminId = getDb().select().from(users).get()!.id;
  await writeLocalCredentials(adminId, 'admin-password');
  getDb()
    .insert(users)
    .values({ kind: 'local', username: 'bob', name: '路人', role: 'user', createdAt: Date.now() })
    .run();
  const bobId = getDb().select().from(users).where(eq(users.username, 'bob')).get()!.id;
  await writeLocalCredentials(bobId, 'bob-password');

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'admin', password: 'admin-password' }),
  });
  adminCookie = cookieOf(login);
  const loginBob = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'bob', password: 'bob-password' }),
  });
  userCookie = cookieOf(loginBob);
});

afterAll(() => {
  stopAllPersistent();
  gw.close();
  closeDb();
  teardownTestDb(dir);
});

// ---------- manifest.env 声明校验（纯单元，不需要 python） ----------

describe('manifest.env 声明校验', () => {
  const baseManifest = { name: 'x', type: 'python', entry: 'mod.py' };

  it('速记字符串 → required+description', () => {
    const m = validateManifest({ ...baseManifest, env: { FOO: '一个变量' } });
    expect(m.env.FOO).toMatchObject({ required: true, secret: false, description: '一个变量' });
  });

  it('保留名拒声明（AAP_* / PORT / HTTP_PROXY）', () => {
    for (const name of ['AAP_TOKEN', 'aap_db_path', 'PORT', 'HTTP_PROXY', 'PATH']) {
      expect(() => validateManifest({ ...baseManifest, env: { [name]: 'x' } })).toThrow(/保留名/);
    }
  });

  it('机密变量不允许 default；非法正则拒绝；超量拒绝', () => {
    expect(() => validateManifest({ ...baseManifest, env: { K: { secret: true, default: 'x' } } })).toThrow(/default/);
    expect(() => validateManifest({ ...baseManifest, env: { K: { pattern: '[' } } })).toThrow(/正则/);
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`V${i}`, 'x']));
    expect(() => validateManifest({ ...baseManifest, env: many })).toThrow(/最多/);
  });
});

// ---------- 配置 API + 注入端到端 ----------

describe.skipIf(!pythonOk)('环境变量配置与沙箱注入', () => {
  it('上传带 env 声明的包 → 配置 → 执行读到注入值', async () => {
    const submit = await fetch(`${base}/api/apps/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({
        filename: 'envtool.neon-aap',
        dataBase64: zipPkg({ 'manifest.json': JSON.stringify(ENV_MANIFEST), 'mod.py': ENV_MOD }),
      }),
    });
    expect(submit.status).toBe(200);

    // 未配置必填变量 → 执行明确报错
    const r0 = await fetch(`${base}/api/apps/envtool/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ input: {} }),
    });
    expect(r0.status).toBe(400);
    expect(((await r0.json()) as { error: { message: string } }).error.message).toContain('ANALYSIS_KEY');

    // GET：声明可见，机密未配置
    const g0 = (await (
      await fetch(`${base}/api/apps/envtool/env`, { headers: { cookie: adminCookie } })
    ).json()) as { declared: Array<{ name: string; configured: boolean; secret: boolean; default: string | null }> };
    expect(g0.declared).toHaveLength(2);
    expect(g0.declared.find((v) => v.name === 'ANALYSIS_KEY')).toMatchObject({ configured: false, secret: true, required: true });
    expect(g0.declared.find((v) => v.name === 'MAX_ITEMS')).toMatchObject({ configured: false, default: '50' });

    // 非归属者不可读写
    const forbidden = await fetch(`${base}/api/apps/envtool/env`, { headers: { cookie: userCookie } });
    expect(forbidden.status).toBe(403);

    // pattern 不符 / 未声明变量 → 拒绝
    const badPattern = await fetch(`${base}/api/apps/envtool/env`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ values: { ANALYSIS_KEY: 'short' } }),
    });
    expect(badPattern.status).toBe(400);
    const undeclared = await fetch(`${base}/api/apps/envtool/env`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ values: { NOPE: 'x' } }),
    });
    expect(undeclared.status).toBe(400);

    // 配置：机密 + 普通 → 执行读到注入值（未配置的可选变量注入 default）
    const put = await fetch(`${base}/api/apps/envtool/env`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ values: { ANALYSIS_KEY: 'abcd12345678', MAX_ITEMS: '99' } }),
    });
    expect(put.status).toBe(200);

    // GET：机密只回 hint 不回明文；普通变量回明文
    const g1 = (await (
      await fetch(`${base}/api/apps/envtool/env`, { headers: { cookie: adminCookie } })
    ).json()) as {
      declared: Array<{ name: string; configured: boolean; value?: string; hint?: string }>;
    };
    const secretView = g1.declared.find((v) => v.name === 'ANALYSIS_KEY')!;
    expect(secretView.configured).toBe(true);
    expect(secretView.hint).toBe('••••5678');
    expect(secretView.value).toBeUndefined();
    expect(JSON.stringify(g1)).not.toContain('abcd12345678');
    expect(g1.declared.find((v) => v.name === 'MAX_ITEMS')!.value).toBe('99');

    // 执行：子进程 os.environ 读到注入值
    const run = await fetch(`${base}/api/apps/envtool/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ input: {} }),
    });
    expect(run.status).toBe(200);
    const rb = (await run.json()) as { status: string; result: { key: string; max_items: string } };
    expect(rb.status).toBe('ok');
    expect(rb.result.key).toBe('abcd12345678');
    expect(rb.result.max_items).toBe('99');
  });

  it('清除机密后缺必填拦截；可选变量未配置时注入声明 default', async () => {
    // 清空全部 → 必填缺配拦截
    const clear = await fetch(`${base}/api/apps/envtool/env`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ values: { ANALYSIS_KEY: '', MAX_ITEMS: '' } }),
    });
    expect(clear.status).toBe(200);
    const g = (await (
      await fetch(`${base}/api/apps/envtool/env`, { headers: { cookie: adminCookie } })
    ).json()) as { declared: Array<{ name: string; configured: boolean }> };
    expect(g.declared.every((v) => !v.configured)).toBe(true);
    const run0 = await fetch(`${base}/api/apps/envtool/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ input: {} }),
    });
    expect(run0.status).toBe(400);

    // 只配必填机密 → MAX_ITEMS 未配置，注入声明 default '50'
    await fetch(`${base}/api/apps/envtool/env`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ values: { ANALYSIS_KEY: 'zzzz99998888' } }),
    });
    const run1 = await fetch(`${base}/api/apps/envtool/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ input: {} }),
    });
    expect(run1.status).toBe(200);
    const rb = (await run1.json()) as { status: string; result: { key: string; max_items: string } };
    expect(rb.status).toBe('ok');
    expect(rb.result.key).toBe('zzzz99998888');
    expect(rb.result.max_items).toBe('50');
  });

  it('persistent 沙箱：路由处理器可见 aap（runner 须在模块执行前经 builtins 注入）', async () => {
    const PERSIST_MOD = `
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

# 模块顶层即引用 aap：runner 的 builtins 注入若缺失，进程将在启动时 NameError 崩溃
AAP_VISIBLE = aap is not None

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({
            "hello": "persistent",
            "aap_top": AAP_VISIBLE,
            "aap_route": aap is not None,
            "app_id": os.environ.get("AAP_APP_ID", ""),
        }).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

HTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler).serve_forever()
`;
    const submit = await fetch(`${base}/api/apps/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({
        filename: 'persistenv.neon-aap',
        dataBase64: zipPkg({
          'manifest.json': JSON.stringify({
            name: 'persistenv', display_name: 'PersistEnv', version: '1.0.0',
            type: 'python', entry: 'mod.py', runtime: 'persistent', capabilities: [], network: [],
          }),
          'mod.py': PERSIST_MOD,
        }),
      }),
    });
    expect(submit.status).toBe(200);

    let body = '';
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${base}/app/persistenv/`, { headers: { cookie: adminCookie } });
      body = await res.text();
      if (res.status === 200 && body.includes('aap_top')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const parsed = JSON.parse(body) as { aap_top: boolean; aap_route: boolean; app_id: string };
    expect(parsed.aap_top).toBe(true);
    expect(parsed.aap_route).toBe(true);
    expect(parsed.app_id).toBe('persistenv');
  });

  it('egress：自定义请求头经平台代理转发（逐跳头剥除，管理员内网白名单放行本地桩）', async () => {
    // 本地桩上游：回显收到的请求头
    let seen: Record<string, string> = {};
    const upstream = createServer((req, res) => {
      seen = req.headers as Record<string, string>;
      res.end(JSON.stringify(req.headers)); // 回显请求头：包侧由此断言平台转发了什么
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    setSetting('EGRESS_INTRANET_ALLOWLIST', '127.0.0.1');
    try {
      const submit = await fetch(`${base}/api/apps/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
        body: JSON.stringify({
          filename: 'egresstool.neon-aap',
          dataBase64: zipPkg({
            'manifest.json': JSON.stringify({
              name: 'egresstool', display_name: 'EgressTool', version: '1.0.0',
              type: 'python', entry: 'mod.py', runtime: 'invoked', capabilities: [], network: [],
            }),
            'mod.py': `
import json

def handle(input, aap):
    r = aap.http.fetch(input["url"], headers={"X-Proof": "secret123", "Host": "evil.example", "Connection": "close"})
    return {"status": r["status"], "seen": json.loads(r["body"])}
`,
          }),
        }),
      });
      expect(submit.status).toBe(200);

      const run = await fetch(`${base}/api/apps/egresstool/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
        body: JSON.stringify({ input: { url: `http://127.0.0.1:${upstreamPort}/probe` } }),
      });
      expect(run.status).toBe(200);
      const rb = (await run.json()) as { status: string; result: { status: number; seen: Record<string, string> } };
      expect(rb.status).toBe('ok');
      expect(rb.result.status).toBe(200); // 上游状态码透传（runner 修复）
      expect(rb.result.seen['x-proof']).toBe('secret123'); // 自定义头到达上游
      expect(rb.result.seen['host']).toBe(`127.0.0.1:${upstreamPort}`); // Host 不可被包改写
      // 注：connection/keep-alive 由传输层自行管理，包侧即使声明也不改变语义
    } finally {
      setSetting('EGRESS_INTRANET_ALLOWLIST', '');
      upstream.close();
    }
  });
});
