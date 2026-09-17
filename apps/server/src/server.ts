/**
 * 服务入口：装配 DB → 种子配置 → Express 应用 → HTTP server →
 * WebSocket upgrade 挂载 → 监听。
 * HTTPS（W6）在证书启用后于同一 upgrade 通道上复用 handleUpgrade。
 */
import http from 'node:http';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { config } from './config/index.js';
import { closeDb, initDb } from './db/index.js';
import { startPurgeLoop, stopPurgeLoop } from './lib/audit.js';
import { startHealthLoop, stopHealthLoop } from './gateway/health.js';
import { startBillingLoop, stopBillingLoop } from './lib/billing.js';
import { handleUpgrade } from './gateway/wsproxy.js';
import * as tls from './gateway/tls.js';
import { stopAllPersistent } from './lib/sandbox.js';
import { stripGatewayPrefix } from './lib/gatewayPrefix.js';
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
  // FPK 统一网关（GATEWAY_PREFIX + SOCKET_PATH，见 deploy/fpk）：在 Express 之前
  // 剥掉 /app/<appname> 前缀，内部保持根路径语义；HTTP 与 WS upgrade 同一处理。
  // TCP 与 Unix Socket 是两个 http.Server 实例（Node 单个 server 不能二次 listen），
  // 共享同一套 handler，未配置 socket 时行为与端口形态完全一致。
  const strip = (req: IncomingMessage): void => {
    req.url = stripGatewayPrefix(req.url, config.gatewayPrefix);
  };
  const requestHandler = (req: IncomingMessage, res: http.ServerResponse): void => {
    strip(req);
    app(req, res);
  };
  const upgradeHandler = (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void => {
    strip(req);
    handleUpgrade(req, socket, head);
  };
  const server = http.createServer(requestHandler);
  // WebSocket（B2）：HTTP 侧升级通道；HTTPS server 复用同一 handler
  server.on('upgrade', upgradeHandler);
  // HTTPS（B3）：注入 app 与 upgrade 处理器，恢复已存证书 / 启动续期循环
  tls.init(app, handleUpgrade);
  tls.restore();
  tls.startRenewalLoop();
  const tcpListenOpts: { port: number; host?: string } = { port: config.port };
  if (config.host) tcpListenOpts.host = config.host;
  server.listen(tcpListenOpts, () => {
    console.log(`[aap] AI应用门户 listening on http://${config.host ?? '0.0.0.0'}:${config.port}`);
    console.log(`[aap] data dir: ${config.dataDir}`);
  });

  let socketServer: http.Server | null = null;
  if (config.socketPath) {
    fs.rmSync(config.socketPath, { force: true }); // 残留 socket 清理（cmd/main stop 已删，双保险）
    socketServer = http.createServer(requestHandler);
    socketServer.on('upgrade', upgradeHandler);
    socketServer.listen(config.socketPath, () => {
      console.log(`[aap] gateway socket listening on ${config.socketPath}`);
    });
  }

  const shutdown = (signal: string) => {
    console.log(`[aap] received ${signal}, shutting down...`);
    stopPurgeLoop();
    stopHealthLoop();
    stopBillingLoop();
    // persistent 沙箱是本进程子进程：容器形态随容器消亡，原生/FPK 形态必须显式回收
    stopAllPersistent();
    tls.stop();
    const finish = () => {
      if (config.socketPath) fs.rmSync(config.socketPath, { force: true });
      closeDb();
      process.exit(0);
    };
    const listeners = new Set<http.Server>([server, ...(socketServer ? [socketServer] : [])]);
    for (const s of listeners) {
      s.close(() => {
        listeners.delete(s);
        if (listeners.size === 0) finish();
      });
    }
    // 兜底：10s 后强退（不再等长连接）
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
