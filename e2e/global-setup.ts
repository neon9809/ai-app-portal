import http from 'node:http';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { generate as totpGenerate } from 'otplib';

/**
 * E2E 全局装配：
 *  - mock 上游应用（9911：HTML 标记页 + JSON 回显）
 *  - 门户服务（9910：tsx 起真实 server，临时数据目录，生产 web 构建产物）
 *  - 预置：初始管理员（已知密码）→ 登录 → 创建 demo 应用 → 开放注册
 *    （P1-6 强制流程门禁后，管理端点须先走完 改密+绑 MFA 的强制流程；
 *     配置完成后直写 DB 把 admin 还原为初始态，F3 仍验收首启向导 UI）
 */

export const PORTAL = 'http://127.0.0.1:9910';
export const UPSTREAM = 'http://127.0.0.1:9912'; // 避开本地体验用的 9911
export const INIT_ADMIN_PASSWORD = 'e2e-init-password';
export const ADMIN_NEW_PASSWORD = 'e2e-new-password-123';

const RUN_DIR = path.join(__dirname, '.run');
const SERVER_LOG = path.join(RUN_DIR, 'server.log');

let portal: ChildProcess | null = null;
let upstream: http.Server | null = null;

export async function setup(): Promise<void> {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  // 清掉残留的旧服务进程（避免端口/数据目录竞争）
  try {
    execFileSync('pkill', ['-f', 'tsx src/server.ts'], { stdio: 'ignore' });
  } catch {
    /* 没有残留 */
  }
  await new Promise((r) => setTimeout(r, 800));
  fs.rmSync(path.join(RUN_DIR, 'data'), { recursive: true, force: true });
  fs.writeFileSync(SERVER_LOG, '');

  // mock 上游应用
  upstream = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/api/echo')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url, headers: req.headers }));
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      `<!doctype html><html><head><title>demo</title></head>` +
        `<body><h1 id="upstream-marker">DEMO-UPSTREAM-OK</h1>` +
        `<p>url=${url}</p></body></html>`,
    );
  });
  await new Promise<void>((r) => upstream!.listen(9912, '127.0.0.1', r));

  // 门户服务（tsx 直跑，生产 web 产物由 WEB_DIST 指定）
  const serverDir = path.join(__dirname, '../apps/server');
  portal = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: '9910',
      DATA_DIR: path.join(RUN_DIR, 'data'),
      WEB_DIST: path.join(__dirname, '../apps/web/dist'),
      ADMIN_INITIAL_PASSWORD: INIT_ADMIN_PASSWORD,
      ADMIN_USERNAME: 'admin',
    },
    stdio: ['ignore', fs.openSync(SERVER_LOG, 'a'), fs.openSync(SERVER_LOG, 'a')],
    detached: false,
  });
  await waitHealthy(`${PORTAL}/api/health`, 30_000);

  // 预置数据：登录初始管理员 → 开放注册 → 接入 demo 应用
  const login = await fetch(`${PORTAL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PORTAL },
    body: JSON.stringify({ username: 'admin', password: INIT_ADMIN_PASSWORD }),
  });
  if (!login.ok) throw new Error(`初始管理员登录失败: ${login.status}`);
  const cookie = (login.headers.getSetCookie().find((c) => c.startsWith('aap_sid=')) ?? '').split(';')[0];

  // 记录初始 admin 行（用于配置后还原初始态，F3 继续验收首启向导）。
  // better-sqlite3 须从 server 的 node_modules 解析（pnpm 严格布局），故 cwd 指向 apps/server。
  const dbPath = path.join(RUN_DIR, 'data', 'app.db');
  const runDb = (script: string, ...args: string[]): string =>
    execFileSync('node', ['-e', script, dbPath, ...args], { cwd: path.join(__dirname, '../apps/server') }).toString();
  const pristine = JSON.parse(
    runDb(
      "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});" +
        "const u=db.prepare('SELECT * FROM users WHERE username=?').get('admin');" +
        "const c=db.prepare('SELECT password_hash FROM local_credentials WHERE user_id=?').get(u.id);" +
        "console.log(JSON.stringify({...u,__password_hash:c.password_hash}))",
    ),
  ) as Record<string, unknown> & { __password_hash: string };

  // 强制流程门禁（P1-6）：改密 → 步升 → 绑 TOTP，之后管理端点才放行
  const cp = await api('POST', '/api/auth/change-password', { currentPassword: INIT_ADMIN_PASSWORD, newPassword: ADMIN_NEW_PASSWORD }, cookie);
  if (cp.status !== 200) throw new Error(`改密失败: ${JSON.stringify(cp.body)}`);
  const su = await api('POST', '/api/auth/step-up/password', { password: ADMIN_NEW_PASSWORD }, cookie);
  if (su.status !== 200) throw new Error(`步升失败: ${JSON.stringify(su.body)}`);
  const enroll = await api('POST', '/api/auth/mfa/totp/enroll', undefined, cookie);
  const secret = (enroll.body as { secret?: string }).secret;
  if (!secret) throw new Error(`MFA enroll 失败: ${JSON.stringify(enroll.body)}`);
  const confirm = await api('POST', '/api/auth/mfa/totp/confirm', { token: await totpGenerate({ secret }) }, cookie);
  if (confirm.status !== 200) throw new Error(`MFA confirm 失败: ${JSON.stringify(confirm.body)}`);

  const settings = await api('PUT', '/api/admin/settings', { REGISTRATION_MODE: 'open' }, cookie);
  if (settings.status >= 300) throw new Error(`开放注册失败: ${JSON.stringify(settings.body)}`);
  const app = await api(
    'POST',
    '/api/admin/apps',
    {
      id: 'demo',
      name: '演示应用',
      description: 'E2E 样例：验证网关与卡片墙',
      category: '演示',
      upstream: UPSTREAM,
      visibility: 'public',
      passUser: true,
    },
    cookie,
  );
  if (app.status >= 300) throw new Error(`demo 应用创建失败: ${JSON.stringify(app.body)}`);

  // 还原 admin 初始态：原 users 行 + 原密码哈希，清除 setup 期间产生的 TOTP/恢复码
  {
    const { __password_hash, ...userRow } = pristine;
    const cols = Object.keys(userRow);
    runDb(
      "const D=require('better-sqlite3');const db=new D(process.argv[1]);" +
        `db.prepare('UPDATE users SET ${cols.map((c) => `${c}=@${c}`).join(', ')} WHERE username=@un').run(JSON.parse(process.argv[2]));` +
        "db.prepare('DELETE FROM totp_secrets WHERE user_id=(SELECT id FROM users WHERE username=?)').run('admin');" +
        "db.prepare('DELETE FROM recovery_codes WHERE user_id=(SELECT id FROM users WHERE username=?)').run('admin');" +
        "db.prepare('UPDATE local_credentials SET password_hash=? WHERE user_id=(SELECT id FROM users WHERE username=?)').run(process.argv[3],'admin');",
      JSON.stringify({ ...userRow, un: 'admin' }),
      __password_hash as string,
    );
  }
}

export async function teardown(): Promise<void> {
  portal?.kill('SIGTERM');
  upstream?.close();
}

async function api(
  method: string,
  p: string,
  json: unknown,
  cookie?: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${PORTAL}${p}`, {
    method,
    headers: { 'content-type': 'application/json', origin: PORTAL, ...(cookie ? { cookie } : {}) },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function waitHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`服务未就绪: ${url}（日志: ${SERVER_LOG}）`);
}

/** 从服务端日志提取最新验证码（未配置 SMTP 的日志兜底通道） */
export function latestCodeFromLog(): string {
  const text = fs.readFileSync(SERVER_LOG, 'utf8');
  const matches = [...text.matchAll(/code=(\d{6})/g)];
  const last = matches[matches.length - 1];
  if (!last) throw new Error('日志中无验证码');
  return last[1]!;
}
