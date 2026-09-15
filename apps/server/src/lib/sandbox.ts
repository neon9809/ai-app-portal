/**
 * .neon-aap Python 沙箱运行管理器（M4，G2）：
 *  - invoked：每次执行拉起子进程（python3 runner.py），stdin JSON / stdout JSON，超时强杀
 *  - persistent：首次访问拉起长驻进程（注入 PORT），空闲回收、崩溃重启一次
 * 隔离现状：SDK 出网的受控通道 = 平台 egress 代理（白名单/IP 黑名单逐跳校验，
 * 见 routes/aap.ts）。注意：**进程级隔离（禁直连网络、CPU/内存限额、ns/cgroups）
 * 尚未实装**——包代码仍可自行出网、读取同用户可访问的文件系统，因此第三方包
 * 必须先经审核流（G3）再放开可见性；完整隔离按 PRD G2 在容器形态补齐。
 * 子进程环境变量走白名单（见 SANDBOX_ENV_KEYS），宿主敏感配置不进沙箱。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { config } from '../config/index.js';
import { getDb } from '../db/index.js';
import { users } from '../db/schema.js';
import { appSiteDir } from '../gateway/staticApp.js';
import { signIdentity } from '../gateway/identity.js';
import type { SessionUser } from '../types.js';
import { getAppLlmProvision } from './llm.js';
import { getSettingInt } from './settings.js';
import { HttpError } from './httpError.js';
import { envValues as appEnvValues } from './appEnv.js';

const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
// src/lib → 根目录需上溯 4 级；Docker 内可用 AAP_RUNNER 覆盖为 /out/aap-sdk/... 
const REPO_ROOT = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '../../../../');
const RUNNER = process.env.AAP_RUNNER || path.join(REPO_ROOT, 'packages', 'aap-sdk', 'aap_runtime', 'runner.py');

/**
 * 沙箱子进程环境白名单：只传 Python 运行所需的最小集合，绝不整体继承
 * process.env（否则 DATABASE_URL、密钥路径等宿主配置会泄露给包代码）。
 * 代理变量放行：部署侧若配置了 egress 代理可继续生效。
 */
const SANDBOX_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'PYTHONUNBUFFERED',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

export function packageEntryPath(appId: string, entry: string): string {
  return path.join(appSiteDir(appId), entry || 'mod.py');
}

/**
 * 可选降权：容器形态可设 SANDBOX_UID / SANDBOX_GID，让沙箱 Python 进程以
 * 预建的非特权用户运行（需保证 DATA_DIR/appsites 对该 uid 可写）。
 * 未设置时不传 uid/gid（跟随宿主进程），开发机默认行为不变。
 */
function sandboxSpawnUser(): { uid?: number; gid?: number } {
  const out: { uid?: number; gid?: number } = {};
  const uid = Number(process.env.SANDBOX_UID);
  const gid = Number(process.env.SANDBOX_GID);
  if (Number.isInteger(uid) && uid > 0) out.uid = uid;
  if (Number.isInteger(gid) && gid > 0) out.gid = gid;
  return out;
}

function baseEnv(appId: string, extra: Record<string, string> = {}): Record<string, string> {
  const provision = getAppLlmProvision(appId);
  const env: Record<string, string> = {};
  for (const k of SANDBOX_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return {
    ...env,
    AAP_APP_ID: appId,
    AAP_PLATFORM: `http://127.0.0.1:${config.port}`,
    ...(provision ? { AAP_TOKEN: provision.token } : {}),
    AAP_PACKAGE_DIR: appSiteDir(appId),
    AAP_DB_PATH: path.join(appSiteDir(appId), 'app.sqlite'),
    AAP_STORAGE_DIR: path.join(appSiteDir(appId), 'storage'),
    // 包声明的环境变量/机密（manifest.env，app_env_vars 解密；保留名已在上传时拒声明，
    // 覆盖不了上面的平台键。放 extra 之前：平台键优先级恒高于包声明）
    ...appEnvValues(appId),
    ...extra,
  };
}

/**
 * 运行用户签名身份（M4 出口标准：沙箱内 LLM 调用计入调用者）。
 * runner 经 AAP_IDENTITY_PAYLOAD/SIG 回传 x-aap-identity*，/api/aap/llm/chat
 * 验签归因 → 网关预检按用户余额拦截与扣费。invoked：归因到发起执行的用户
 * （10 分钟 TTL 覆盖 30s 执行窗口绰绰有余）；persistent 为多用户长驻，
 * 归因走代理逐请求注入的身份头（见 proxyToSandbox），不放进程环境。
 */
export function identityEnv(appId: string, userId: number | null): Record<string, string> {
  if (userId === null) return {};
  const u = getDb().select().from(users).where(eq(users.id, userId)).get();
  if (!u) return {};
  const su: SessionUser = {
    id: u.id,
    kind: u.kind === 'oidc' ? 'oidc' : 'local',
    subject: u.kind === 'oidc' ? `oidc:${u.email ?? u.id}` : `local:${u.username ?? u.id}`,
    username: u.username,
    email: u.email,
    phone: u.phone,
    name: u.name || u.username || `用户${u.id}`,
    role: u.role === 'admin' ? 'admin' : 'user',
    status: u.status,
    sessionId: 'aap-sandbox',
    authState: 'full',
    stepUpUntil: null,
    plan: u.plan === 'member' ? 'member' : 'free',
    mfaEnabled: Boolean(u.mfaEnabled),
    mustChangePassword: Boolean(u.mustChangePassword),
  };
  const idn = signIdentity(su, appId);
  if (!idn) return {};
  return { AAP_IDENTITY_PAYLOAD: idn.payload, AAP_IDENTITY_SIG: idn.sig };
}

// ---------- invoked ----------

export interface InvokedResult {
  status: 'ok' | 'error' | 'timeout';
  result?: unknown;
  error?: string;
  logs: string;
  durationMs: number;
}

function runInvokedOnce(
  appId: string,
  entry: string,
  input: unknown,
  opts: { userId: number | null; timeoutMs?: number; platformBase?: string },
): Promise<InvokedResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    const child = spawn(
      PYTHON_BIN,
      [RUNNER, 'run'],
      {
        cwd: appSiteDir(appId),
        env: baseEnv(appId, {
          AAP_MODE: 'run',
          AAP_MOD_PATH: packageEntryPath(appId, entry),
          AAP_RUN_ID: randomId(),
          AAP_USER_ID: opts.userId !== null ? String(opts.userId) : '',
          AAP_DEBUG: '0',
          ...(opts.platformBase ? { AAP_PLATFORM: opts.platformBase } : {}),
          ...identityEnv(appId, opts.userId),
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
        ...sandboxSpawnUser(),
      },
    );

    // 输出捕获上限：包内死循环 print 不再无限吃内存（超出部分丢弃）
    const MAX_CAPTURE = 512 * 1024;
    let stdout = '';
    let logs = '';
    let done = false;
    child.stdout.on('data', (c: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += c.toString('utf8').slice(0, MAX_CAPTURE - stdout.length);
    });
    child.stderr.on('data', (c: Buffer) => {
      if (logs.length < MAX_CAPTURE) logs += c.toString('utf8').slice(0, MAX_CAPTURE - logs.length);
    });
    const finish = (r: InvokedResult) => {
      if (done) return;
      done = true;
      r.logs = logs.slice(-8_000);
      r.durationMs = Date.now() - started;
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      resolve(r);
    };
    const killer = setTimeout(() => finish({ status: 'timeout', logs, durationMs: Date.now() - started }), timeoutMs);

    child.on('error', (err) => {
      clearTimeout(killer);
      // 全量进服务端日志；对外只给状态（err.message 含容器内路径，防泄露）
      console.error(`[sandbox] invoked 进程启动失败 (${appId}):`, err.message);
      finish({ status: 'error', error: '沙箱进程启动失败（运行时不可用）', logs, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0) {
        try {
          // stdout 可能多行（包内 print），取最后一行合法 JSON
          const lines = stdout.trim().split('\n');
          finish({ status: 'ok', result: JSON.parse(lines[lines.length - 1] ?? 'null'), logs, durationMs: Date.now() - started });
        } catch {
          finish({ status: 'error', error: '输出不是合法 JSON（包内请不要 print 非 JSON 内容）', logs, durationMs: Date.now() - started });
        }
      } else {
        const errLine = logs.trim().split('\n').filter((l) => !l.startsWith('{')).pop();
        finish({
          status: 'error',
          error: errLine?.slice(0, 500) || `进程退出码 ${code}`,
          logs,
          durationMs: Date.now() - started,
        });
      }
    });

    child.stdin.write(JSON.stringify({ input: input ?? {} }));
    child.stdin.end();
  });
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ---------- 全局并发闸（防进程炸弹：每次执行一个 Python 进程，必须限流） ----------

let activeRuns = 0;
const runQueue: Array<() => void> = [];
const MAX_QUEUE = 64;

function sandboxMaxConcurrent(): number {
  return Math.max(1, getSettingInt('SANDBOX_MAX_CONCURRENT_RUNS', 8));
}

/** 取一个执行槽位；超出上限时 FIFO 排队。返回释放函数。 */
function acquireRunSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = (): void => {
      activeRuns++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activeRuns--;
        const next = runQueue.shift();
        if (next) next();
      });
    };
    if (activeRuns < sandboxMaxConcurrent()) grant();
    else runQueue.push(grant);
  });
}

export function runInvoked(
  appId: string,
  entry: string,
  input: unknown,
  opts: { userId: number | null; timeoutMs?: number; platformBase?: string },
): Promise<InvokedResult> {
  // 排队上限：执行槽满且队列也满时直接 429（无界排队会积压请求内存）
  if (activeRuns >= sandboxMaxConcurrent() && runQueue.length >= MAX_QUEUE) {
    return Promise.reject(new HttpError(429, 'SANDBOX_BUSY', '沙箱执行排队已满，请稍后重试'));
  }
  return acquireRunSlot().then((release) =>
    runInvokedOnce(appId, entry, input, opts).finally(release),
  );
}

// ---------- persistent ----------

interface PersistentProc {
  proc: ChildProcess;
  port: number;
  lastUsed: number;
  restarts: number;
}

const persistent = new Map<string, PersistentProc>();
/** 空闲回收阈值：SANDBOX_IDLE_RECYCLE_SECONDS 设置（最小 30s，默认 300s）。
 *  进程被回收后下次访问重新拉起（任务型应用状态应落 aap.db 不受影响）。 */
function idleRecycleMs(): number {
  return Math.max(30, getSettingInt('SANDBOX_IDLE_RECYCLE_SECONDS', 300)) * 1000;
}
const MAX_RESTARTS = 3;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

import type { AddressInfo } from 'node:net';

export async function ensurePersistent(
  appId: string,
  entry: string,
  onCrash?: (appId: string, restarts: number) => void,
  startRestarts = 0,
): Promise<number | null> {
  const existing = persistent.get(appId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.port;
  }
  const port = await freePort();
  // await 之后复查：并发首访时第二个请求直接复用第一个请求拉起的进程
  const raced = persistent.get(appId);
  if (raced) {
    raced.lastUsed = Date.now();
    return raced.port;
  }
  const proc = spawn(
    PYTHON_BIN,
    [RUNNER, 'serve'],
    {
      cwd: appSiteDir(appId),
      env: baseEnv(appId, {
        AAP_MODE: 'serve',
        AAP_MOD_PATH: packageEntryPath(appId, entry),
        AAP_RUN_ID: randomId(),
        PORT: String(port),
      }),
      stdio: 'ignore',
      ...sandboxSpawnUser(),
    },
  );
  const entry_: PersistentProc = { proc, port, lastUsed: Date.now(), restarts: startRestarts };
  persistent.set(appId, entry_);

  // spawn 失败（如运行时缺失）必须有监听，否则 error 事件成为 uncaught exception 拖垮主进程
  proc.on('error', (err) => {
    console.error(`[sandbox] persistent 进程启动失败 (${appId}):`, err.message);
  });

  proc.on('exit', () => {
    // 只清理自己登记的条目：避免被回收/替换后误删后继进程的登记
    if (persistent.get(appId) !== entry_) return;
    persistent.delete(appId);
    // 崩溃自动重启（非人为 kill）；计数随条目继承传递，上限防 CrashLoop
    // （此前每次 respawn 新建条目从 0 计数，上限永不生效，已修）
    if (entry_.restarts < MAX_RESTARTS) {
      entry_.restarts++;
      onCrash?.(appId, entry_.restarts);
      void ensurePersistent(appId, entry, onCrash, entry_.restarts);
    }
  });

  // 等端口就绪（最多 10s）
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    if (ok) return port;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

export function touchPersistent(appId: string): void {
  const p = persistent.get(appId);
  if (p) p.lastUsed = Date.now();
}

export function touchByPort(port: number): void {
  for (const [, p] of persistent) {
    if (p.port === port) p.lastUsed = Date.now();
  }
}

export function persistentPort(appId: string): number | null {
  return persistent.get(appId)?.port ?? null;
}

export function stopAllPersistent(): void {
  for (const [, p] of persistent) p.proc.kill('SIGTERM');
  persistent.clear();
}

/** 停掉指定应用的 persistent 进程（环境变量/机密变更后，下次访问以新环境重新拉起） */
export function stopPersistentFor(appId: string): void {
  const p = persistent.get(appId);
  if (!p) return;
  persistent.delete(appId);
  try {
    p.proc.kill('SIGTERM');
  } catch {
    /* 已退出 */
  }
}

// 空闲回收（每分钟巡检；阈值即时读设置，管理端改完即生效）
setInterval(() => {
  const now = Date.now();
  const limit = idleRecycleMs();
  for (const [appId, p] of persistent) {
    if (now - p.lastUsed > limit) {
      p.proc.kill('SIGTERM');
      persistent.delete(appId);
      console.log(`[sandbox] persistent 空闲回收: ${appId}`);
    }
  }
}, 60_000).unref();
