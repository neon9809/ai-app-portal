/**
 * 上游健康探测（E2 状态仪表卡数据源）：周期对启用的应用做 HEAD 探测
 * （5s 超时）→ healthState ok/down + lastProbeAt。单实例进程内定时器。
 * 门户托管应用（html/package）没有独立 upstream，此前对空地址发 HEAD
 * 必然抛错 → 仪表卡恒「异常」：html 由门户本地服务恒健康；persistent
 * 包未拉起/已回收时记 unknown（不算异常）；invoked 包视为健康（执行
 * 健康看 app_runs 运行记录）。
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { apps } from '../db/schema.js';
import { listApps } from './registry.js';
import { persistentPort } from '../lib/sandbox.js';

const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

async function probeOne(app: { id: string; upstream: string }): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(app.upstream, { method: 'HEAD', redirect: 'manual', signal: ctrl.signal });
    // 任何 HTTP 响应都算「可达」；5xx 视为 down
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeAll(): Promise<void> {
  for (const app of listApps()) {
    if (!app.enabled) continue;
    let state: 'ok' | 'down' | 'unknown';
    if (app.kind === 'upstream') {
      state = (await probeOne(app)) ? 'ok' : 'down';
    } else if (app.kind === 'html') {
      state = 'ok'; // 门户托管静态页，由门户自身直接服务
    } else if (app.runtimeMode === 'persistent' && persistentPort(app.id) === null) {
      state = 'unknown'; // 尚未拉起或已空闲回收，不代表异常
    } else {
      state = 'ok';
    }
    getDb()
      .update(apps)
      .set({ healthState: state, lastProbeAt: Date.now() })
      .where(eq(apps.id, app.id))
      .run();
  }
}

let timer: NodeJS.Timeout | null = null;

export function startHealthLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    void probeAll().catch((err) => console.error('[health] probe failed:', err));
  }, PROBE_INTERVAL_MS);
  timer.unref();
  // 启动后 3s 先探一轮（不阻塞启动）
  setTimeout(() => void probeAll().catch(() => {}), 3_000).unref();
}

export function stopHealthLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
