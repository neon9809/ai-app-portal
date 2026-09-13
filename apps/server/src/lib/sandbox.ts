/**
 * .neon-aap Python 沙箱运行管理器（M4，G2）：
 *  - invoked：每次执行拉起子进程（python3 runner.py），stdin JSON / stdout JSON，超时强杀
 *  - persistent：首次访问拉起长驻进程（注入 PORT），空闲回收、崩溃重启一次
 * 隔离：SDK 出网唯一通道 = 平台 egress 代理（白名单在平台侧执行）；容器部署叠加 ns/cgroups。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { config } from '../config/index.js';
import { appSiteDir } from '../gateway/staticApp.js';
import { getAppLlmProvision } from './llm.js';

const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
// src/lib → 根目录需上溯 4 级；Docker 内可用 AAP_RUNNER 覆盖为 /out/aap-sdk/... 
const REPO_ROOT = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '../../../../');
const RUNNER = process.env.AAP_RUNNER || path.join(REPO_ROOT, 'packages', 'aap-sdk', 'aap_runtime', 'runner.py');

export function packageEntryPath(appId: string, entry: string): string {
  return path.join(appSiteDir(appId), entry || 'mod.py');
}

function baseEnv(appId: string, extra: Record<string, string> = {}): Record<string, string> {
  const provision = getAppLlmProvision(appId);
  return {
    ...process.env,
    AAP_APP_ID: appId,
    AAP_PLATFORM: `http://127.0.0.1:${config.port}`,
    ...(provision ? { AAP_TOKEN: provision.token } : {}),
    AAP_PACKAGE_DIR: appSiteDir(appId),
    AAP_DB_PATH: path.join(appSiteDir(appId), 'app.sqlite'),
    AAP_STORAGE_DIR: path.join(appSiteDir(appId), 'storage'),
    ...extra,
  };
}

// ---------- invoked ----------

export interface InvokedResult {
  status: 'ok' | 'error' | 'timeout';
  result?: unknown;
  error?: string;
  logs: string;
  durationMs: number;
}

export function runInvoked(
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
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let logs = '';
    let done = false;
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (logs += c));
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
      finish({ status: 'error', error: err.message, logs, durationMs: Date.now() - started });
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

// ---------- persistent ----------

interface PersistentProc {
  proc: ChildProcess;
  port: number;
  lastUsed: number;
  restarts: number;
}

const persistent = new Map<string, PersistentProc>();
const IDLE_RECYCLE_MS = 5 * 60_000;
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
): Promise<number | null> {
  const existing = persistent.get(appId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.port;
  }
  const port = await freePort();
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
    },
  );
  const entry_: PersistentProc = { proc, port, lastUsed: Date.now(), restarts: 0 };
  persistent.set(appId, entry_);

  proc.on('exit', () => {
    persistent.delete(appId);
    // 崩溃自动重启（非人为 kill；次数上限防 CrashLoop）
    if (entry_.restarts < MAX_RESTARTS) {
      entry_.restarts++;
      onCrash?.(appId, entry_.restarts);
      void ensurePersistent(appId, entry, onCrash);
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

// 空闲回收
setInterval(() => {
  const now = Date.now();
  for (const [appId, p] of persistent) {
    if (now - p.lastUsed > IDLE_RECYCLE_MS) {
      p.proc.kill('SIGTERM');
      persistent.delete(appId);
      console.log(`[sandbox] persistent 空闲回收: ${appId}`);
    }
  }
}, 60_000).unref();
