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
import { startBillingLoop, stopBillingLoop } from './lib/billing.js';
import { handleUpgrade } from './gateway/wsproxy.js';
import * as tls from './gateway/tls.js';
import { ensureInitialAdmin, seedOfficialSigningKey } from './lib/bootstrap.js';
import { seedSettings } from './lib/settings.js';
import { createApp } from './app.js';

function main(): void {
  if (config.databaseTarget.kind === 'mysql') {
    console.error('[aap] MySQL 数据库方言将在 FPK 集成版本中启用，当前版本请使用 SQLite（默认）。');
    process.exit(1);
  }
  initDb({ file: config.databaseTarget.file, migrationsDir: config.migrationsDir });
  seedSettings();
  seedOfficialSigningKey(); // G4：AAP_OFFICIAL_SIGN_PUBKEY 提供时内置信任官方签名公钥
  ensureInitialAdmin(); // F3：users 为空时创建初始管理员（Docker 首启打印密码 + 一次性凭据文件）
  startPurgeLoop();
  startHealthLoop();
  startBillingLoop();

  const app = createApp();
  const server = http.createServer(app);
  // WebSocket（B2）：HTTP 侧升级通道；HTTPS server 复用同一 handler
  server.on('upgrade', handleUpgrade);
  // HTTPS（B3）：注入 app 与 upgrade 处理器，恢复已存证书 / 启动续期循环
  tls.init(app, handleUpgrade);
  tls.restore();
  tls.startRenewalLoop();
  server.listen(config.port, () => {
    console.log(`[aap] AI应用门户 listening on http://localhost:${config.port}`);
    console.log(`[aap] data dir: ${config.dataDir}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[aap] received ${signal}, shutting down...`);
    stopPurgeLoop();
    stopHealthLoop();
    stopBillingLoop();
    tls.stop();
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
