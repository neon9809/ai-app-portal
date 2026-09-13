/**
 * 服务入口：装配 DB → 种子配置 → Express 应用 → HTTP server →
 * WebSocket upgrade 挂载 → 监听。
 * HTTPS（W6）在证书启用后于同一 upgrade 通道上复用 handleUpgrade。
 */
import http from 'node:http';
import { config } from './config/index.js';
import { closeDb, initDb } from './db/index.js';
import { startPurgeLoop, stopPurgeLoop } from './lib/audit.js';
import { startHealthLoop, stopHealthLoop } from './gateway/health.js';
import { handleUpgrade } from './gateway/wsproxy.js';
import { ensureInitialAdmin } from './lib/bootstrap.js';
import { seedSettings } from './lib/settings.js';
import { createApp } from './app.js';

function main(): void {
  initDb({ file: config.databaseFile, migrationsDir: config.migrationsDir });
  seedSettings();
  ensureInitialAdmin(); // F3：users 为空时创建初始管理员（Docker 首启打印密码 + 一次性凭据文件）
  startPurgeLoop();
  startHealthLoop();

  const app = createApp();
  const server = http.createServer(app);
  // WebSocket（B2）：HTTP 侧升级通道；HTTPS server（W6）同样挂 handleUpgrade
  server.on('upgrade', handleUpgrade);
  server.listen(config.port, () => {
    console.log(`[aap] AI应用门户 listening on http://localhost:${config.port}`);
    console.log(`[aap] data dir: ${config.dataDir}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[aap] received ${signal}, shutting down...`);
    stopPurgeLoop();
    stopHealthLoop();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    // 兜底：10s 后强退（不再等长连接）
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
