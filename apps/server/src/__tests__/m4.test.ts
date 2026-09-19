/**
 * M4 生态测试（G2/G3/G4/G5）：
 * 包上传（manifest 校验）→ 私有可用 → invoked 沙箱执行（echo / 每包 SQLite / 白名单拒绝）
 * → 提交审核 → 管理员通过/驳回。
 * 依赖系统 python3（执行沙箱）。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { WebSocket } from 'ws';
import { sessionCookieFor, setupTestDb, teardownTestDb } from './testkit.js';
import { closeDb, getDb } from '../db/index.js';
import { seedSettings, setSetting } from '../lib/settings.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { handleUpgrade } from '../gateway/wsproxy.js';
import { appSiteDir } from '../gateway/staticApp.js';
import { ensurePersistent, persistentPort, stopAllPersistent, stopPersistentFor } from '../lib/sandbox.js';
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
  gw.on('upgrade', handleUpgrade);
  await new Promise<void>((r) => gw!.once('listening', r));
  base = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;

  // 管理员登录
  getDb()
    .insert((await import('../db/schema.js')).users)
    .values({ kind: 'local', username: 'admin', name: '管理员', role: 'admin', mfaEnabled: true, createdAt: Date.now() })
    .run();
  const { writeLocalCredentials } = await import('../lib/bootstrap.js');
  const adminId = getDb().select().from((await import('../db/schema.js')).users).get()!.id;
  // 直建 full 会话（mfaEnabled=true 时 HTTP 登录只给半登录态）
  adminCookie = sessionCookieFor(adminId);
});

afterAll(() => {
  stopAllPersistent();
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

  it('网络守卫：包内绕过平台代理直连 TCP → 被拒绝', async () => {
    const dataBase64 = zipPkg({
      'manifest.json': JSON.stringify({
        name: 'sneakytool', display_name: 'Sneaky', version: '1.0.0',
        type: 'python', entry: 'mod.py', runtime: 'invoked', capabilities: [], network: [],
      }),
      'mod.py': `
import socket

def handle(input, aap):
    s = socket.socket()
    s.settimeout(2)
    s.connect(("127.0.0.1", 1))
    return {"ok": True}
`,
    });
    const submit = await fetch(`${base}/api/apps/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ filename: 'sneakytool.neon-aap', dataBase64 }),
    });
    expect(submit.status).toBe(200);

    const run = await fetch(`${base}/api/apps/sneakytool/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ input: {} }),
    });
    const b = (await run.json()) as { status: string; error: string };
    expect(b.status).toBe('error');
    expect(b.error).toContain('守卫');
  });

  it('persistent：HTTP 反代可达 + WebSocket 经网关透传回声（stdlib WS 回声服务）', async () => {
    const PERSIST_MOD = `
import base64
import hashlib
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if key:
            accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            try:
                while True:
                    hdr = self.rfile.read(2)
                    if len(hdr) < 2:
                        break
                    opcode = hdr[0] & 0x0F
                    length = hdr[1] & 0x7F
                    if length == 126:
                        length = int.from_bytes(self.rfile.read(2), "big")
                    elif length == 127:
                        length = int.from_bytes(self.rfile.read(8), "big")
                    if hdr[1] & 0x80:
                        mask = self.rfile.read(4)
                        data = bytes(b ^ mask[i % 4] for i, b in enumerate(self.rfile.read(length)))
                    else:
                        data = self.rfile.read(length)
                    self.wfile.write(bytes([0x80 | opcode, len(data)]) + data)
                    self.wfile.flush()
            except Exception:
                pass
            return
        body = b'{"hello": "persistent"}'
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


HTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler).serve_forever()
`;
    const dataBase64 = zipPkg({
      'manifest.json': JSON.stringify({
        name: 'persistapp', display_name: 'Persist', version: '1.0.0',
        type: 'python', entry: 'mod.py', runtime: 'persistent', capabilities: [], network: [],
      }),
      'mod.py': PERSIST_MOD,
    });
    const submit = await fetch(`${base}/api/apps/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ filename: 'persistapp.neon-aap', dataBase64 }),
    });
    expect(submit.status).toBe(200);

    const gwPort = (gw.address() as AddressInfo).port;

    // HTTP：首次请求触发 ensurePersistent 拉起沙箱（最多 ~10s），JSON 经反代原样返回
    let httpOk = false;
    let httpBody = '';
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${base}/app/persistapp/`, { headers: { cookie: adminCookie } });
      const text = await res.text();
      if (res.status === 200 && text.includes('"hello"')) {
        httpOk = true;
        httpBody = text;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(httpOk).toBe(true);
    expect(httpBody).toContain('"persistent"');

    // WS：经网关 upgrade 透传到沙箱端口并回声
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/app/persistapp/ws`, { headers: { cookie: adminCookie } });
    const received = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws timeout')), 8000);
      ws.on('open', () => ws.send('persist'));
      ws.on('message', (d) => {
        clearTimeout(t);
        resolve(d.toString());
      });
      ws.on('error', reject);
    });
    expect(received).toBe('persist');
    ws.close();
  });

  it('persistent WS 路径语义（回归：曾原样含 /app/<id> 前缀转发）：剥前缀 + x-forwarded-prefix；raw 通道剥 raw 段', async () => {
    // 沙箱在 WS 握手成功时首帧回报 self.path 与 x-forwarded-prefix，随后进入回声循环
    const WS_PATH_MOD = `
import base64
import hashlib
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if key:
            accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            info = json.dumps({"path": self.path, "prefix": self.headers.get("X-Forwarded-Prefix")}).encode()
            self.wfile.write(bytes([0x81, len(info)]) + info)
            self.wfile.flush()
            try:
                while True:
                    hdr = self.rfile.read(2)
                    if len(hdr) < 2:
                        break
                    opcode = hdr[0] & 0x0F
                    length = hdr[1] & 0x7F
                    if length == 126:
                        length = int.from_bytes(self.rfile.read(2), "big")
                    elif length == 127:
                        length = int.from_bytes(self.rfile.read(8), "big")
                    if hdr[1] & 0x80:
                        mask = self.rfile.read(4)
                        data = bytes(b ^ mask[i % 4] for i, b in enumerate(self.rfile.read(length)))
                    else:
                        data = self.rfile.read(length)
                    self.wfile.write(bytes([0x80 | opcode, len(data)]) + data)
                    self.wfile.flush()
            except Exception:
                pass
            return
        body = b'{"ok": true}'
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


HTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler).serve_forever()
`;
    const dataBase64 = zipPkg({
      'manifest.json': JSON.stringify({
        name: 'persistpath', display_name: 'PersistPath', version: '1.0.0',
        type: 'python', entry: 'mod.py', runtime: 'persistent', capabilities: [], network: [],
      }),
      'mod.py': WS_PATH_MOD,
    });
    const submit = await fetch(`${base}/api/apps/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ filename: 'persistpath.neon-aap', dataBase64 }),
    });
    expect(submit.status).toBe(200);

    try {
      // HTTP 预热拉起沙箱（首次拉起最多 ~10s），确保后续 WS 首连即通
      let warmed = false;
      for (let i = 0; i < 30; i++) {
        const res = await fetch(`${base}/app/persistpath/`, { headers: { cookie: adminCookie } });
        if (res.status === 200) {
          warmed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(warmed).toBe(true);

      const gwPort = (gw.address() as AddressInfo).port;
      const wsHandshake = (path: string): Promise<{ path: string; prefix: string | null }> =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${gwPort}${path}`, { headers: { cookie: adminCookie } });
          const t = setTimeout(() => reject(new Error('ws timeout')), 8000);
          ws.on('message', (d) => {
            clearTimeout(t);
            ws.close();
            resolve(JSON.parse(d.toString()) as { path: string; prefix: string | null });
          });
          ws.on('error', reject);
        });

      // 普通通道：沙箱看到剥前缀后的根路径（query 保留），前缀经头下发
      const plain = await wsHandshake('/app/persistpath/ws/chat?q=1');
      expect(plain.path).toBe('/ws/chat?q=1');
      expect(plain.prefix).toBe('/app/persistpath');

      // raw 通道：先剥 /app/<id> 再剥 raw 段 → /ws
      const raw = await wsHandshake('/app/persistpath/raw/ws');
      expect(raw.path).toBe('/ws');
      expect(raw.prefix).toBe('/app/persistpath');
    } finally {
      // 清理本用例拉起的 persistent 进程：后序「全局上限」用例对存量进程数有假设
      //（SANDBOX_MAX_PERSISTENT=1 时 makeRoomForPersistent 只回收一个 LRU）
      stopPersistentFor('persistpath');
    }
  }, 20_000);

  it('persistent 全局上限（审计 F3）：超限回收最久未用进程，腾位后新应用可拉起', async () => {
    if (!pythonOk) return;
    const SERVE_MOD = `
import json, os
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = b'{"ok": true}'
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


HTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler).serve_forever()
`;
    for (const id of ['cap-a', 'cap-b']) {
      fs.mkdirSync(appSiteDir(id), { recursive: true });
      fs.writeFileSync(path.join(appSiteDir(id), 'mod.py'), SERVE_MOD);
    }
    setSetting('SANDBOX_MAX_PERSISTENT', '1');
    try {
      const portA = await ensurePersistent('cap-a', 'mod.py');
      expect(portA).not.toBeNull();
      const portB = await ensurePersistent('cap-b', 'mod.py'); // cap-a 被 LRU 回收腾位
      expect(portB).not.toBeNull();
      expect(portB).not.toBe(portA);
      expect(persistentPort('cap-a')).toBeNull();
    } finally {
      setSetting('SANDBOX_MAX_PERSISTENT', '');
      stopAllPersistent();
    }
  }, 30_000);
});

describe('M4 安全回归（鉴权与归属校验）', () => {
  it('匿名访问 run / submit / mine → 401（修复前为 500 或带副作用崩溃）', async () => {
    const run = await fetch(`${base}/api/apps/anyapp/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ input: {} }),
    });
    expect(run.status).toBe(401);
    const submit = await fetch(`${base}/api/apps/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ filename: 'x.neon-aap', dataBase64: 'AAAA' }),
    });
    expect(submit.status).toBe(401);
    const mine = await fetch(`${base}/api/apps/mine`);
    expect(mine.status).toBe(401);
  });

  it('非归属者同名提交 → 409，且原应用文件不被破坏（回归：曾先删后鉴权）', async () => {
    const { writeLocalCredentials } = await import('../lib/bootstrap.js');
    const { users } = await import('../db/schema.js');
    const { appSiteDir } = await import('../gateway/staticApp.js');

    // 归属者（管理员）上传 victimapp，文件带原始标记
    const victimPkg = zipPkg({
      'manifest.json': JSON.stringify({
        name: 'victimapp', display_name: 'Victim', version: '1.0.0',
        type: 'python', entry: 'mod.py', runtime: 'invoked', capabilities: [], network: [],
      }),
      'mod.py': 'VICTIM_ORIGINAL_MARKER = 1\n',
    });
    const up = await fetch(`${base}/api/apps/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({ filename: 'victimapp.neon-aap', dataBase64: victimPkg }),
    });
    expect(up.status).toBe(200);

    // 攻击者（普通用户）同名提交恶意包
    const u = getDb().insert(users)
      .values({ kind: 'local', username: 'mallory', name: 'm', role: 'user', createdAt: Date.now() })
      .run();
    await writeLocalCredentials(Number(u.lastInsertRowid), 'mallory-password');
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'mallory', password: 'mallory-password' }),
    });
    const malloryCookie = cookieOf(login);

    const evilPkg = zipPkg({
      'manifest.json': JSON.stringify({
        name: 'victimapp', display_name: 'Evil', version: '9.9.9',
        type: 'python', entry: 'mod.py', runtime: 'invoked', capabilities: [], network: [],
      }),
      'mod.py': 'EVIL_MARKER = 1\n',
    });
    const evil = await fetch(`${base}/api/apps/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: malloryCookie },
      body: JSON.stringify({ filename: 'evil.neon-aap', dataBase64: evilPkg }),
    });
    expect(evil.status).toBe(409);
    expect(((await evil.json()) as { error: { code: string } }).error.code).toBe('APP_EXISTS');

    // 归属校验失败 → 不允许触碰正式目录（修复前 rmSync 先行会替换成 EVIL_MARKER）
    const onDisk = fs.readFileSync(path.join(appSiteDir('victimapp'), 'mod.py'), 'utf8');
    expect(onDisk).toContain('VICTIM_ORIGINAL_MARKER');
    expect(onDisk).not.toContain('EVIL_MARKER');
  });

  it('账号回归：管理员重置 → 凭返回密码登录 → 强制改密设为同值 → 重登成功', async () => {
    const { writeLocalCredentials } = await import('../lib/bootstrap.js');
    const { users } = await import('../db/schema.js');
    const u = getDb()
      .insert(users)
      .values({ kind: 'local', username: 'resetflow', name: 'rf', role: 'user', createdAt: Date.now() })
      .run();
    const uid = Number(u.lastInsertRowid);
    await writeLocalCredentials(uid, 'first-password');

    // 管理员重置（系统生成新密码）。回归点：曾因 UPDATE 缺 .run() 未持久化，
    // 返回的密码登录必然失败
    const reset = await fetch(`${base}/api/admin/users/${uid}/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
      body: JSON.stringify({}),
    });
    expect(reset.status).toBe(200);
    const { password: P0 } = (await reset.json()) as { password: string };
    expect(P0).toBeTruthy();

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'resetflow', password: P0 }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { mustChangePassword: boolean };
    expect(loginBody.mustChangePassword).toBe(true);
    const cookie = cookieOf(login);

    // 强制改密：新密码 = 初始密码（用户实际踩坑场景：同值提交）
    const change = await fetch(`${base}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: JSON.stringify({ currentPassword: P0, newPassword: P0 }),
    });
    expect(change.status).toBe(200);

    // 退出后用同值密码重登 → 必须成功
    const relogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'resetflow', password: P0 }),
    });
    expect(relogin.status).toBe(200);
    const reloginBody = (await relogin.json()) as { mustChangePassword: boolean };
    expect(reloginBody.mustChangePassword).toBe(false);
  });
});
