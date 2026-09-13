/**
 * 上游健康探测（E2 状态仪表卡数据源）：周期对启用的应用做 HEAD 探测
 * （5s 超时）→ healthState ok/down + lastProbeAt。单实例进程内定时器。
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { apps } from '../db/schema.js';
import { listApps } from './registry.js';

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
    const ok = await probeOne(app);
    getDb()
      .update(apps)
      .set({ healthState: ok ? 'ok' : 'down', lastProbeAt: Date.now() })
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
