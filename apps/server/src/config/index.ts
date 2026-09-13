/**
 * 集中读取 env（dotenv）。启动时读一次；运行时可调策略走 settings 表
 * （lib/settings.ts），env 只作首次种子的初值。
 * 模式移植自参考实现 lib/config.js，剥离单位指纹。
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AapConfig {
  /** 业务监听端口（HTTP；也承载 W6 后的 HTTPS，见 tls） */
  port: number;
  httpsPort: number;
  /** 数据目录：SQLite、证书、密钥、上传件 */
  dataDir: string;
  databaseFile: string;
  migrationsDir: string;
  /** 生产模式下前端构建产物目录（不存在则不托管静态资源） */
  webDist: string | null;

  trustProxy: boolean;

  sessionTtlSec: number;
  sessionCookieName: string;

  proxyEnabled: boolean;
  proxyTimeoutSec: number;
  rateUserPerMin: number;
  rateIpPerMin: number;

  /** PoW（hashcash）默认参数；运行时可被 settings 覆盖 */
  powDifficultyBase: number;
  powDifficultyStep: number;
  powDifficultyMax: number;
  powChallengeTtlSec: number;
  powTokenTtlSec: number;

  loginFailWindowSec: number;
  loginFailThreshold: number;
  ipBanThreshold: number;
  ipBanBaseSec: number;
  ipBanMultiplier: number;
  ipBanMaxSec: number;

  auditRetentionDays: number;

  /** 开发引导：ADMIN_INITIAL_PASSWORD 提供时首启 admin 用它而非随机密码 */
  adminInitialPassword: string | null;
  isDev: boolean;
}

function asInt(v: string | undefined, fallback: number): number {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AapConfig {
  const dataDir = path.resolve(env.DATA_DIR ?? path.join(PKG_ROOT, 'data'));
  return {
    port: asInt(env.PORT, 8080),
    httpsPort: asInt(env.HTTPS_PORT, 8443),
    dataDir,
    databaseFile: env.DATABASE_FILE ? path.resolve(env.DATABASE_FILE) : path.join(dataDir, 'app.db'),
    migrationsDir: env.MIGRATIONS_DIR
      ? path.resolve(env.MIGRATIONS_DIR)
      : path.join(PKG_ROOT, 'drizzle'),
    webDist: env.WEB_DIST ? path.resolve(env.WEB_DIST) : path.join(PKG_ROOT, '../web/dist'),
    trustProxy: asBool(env.TRUST_PROXY, false),

    sessionTtlSec: asInt(env.SESSION_TTL, 86400),
    sessionCookieName: env.SESSION_COOKIE_NAME ?? 'aap_sid',

    proxyEnabled: asBool(env.PROXY_ENABLED, true),
    proxyTimeoutSec: asInt(env.PROXY_TIMEOUT, 30),
    rateUserPerMin: asInt(env.RATE_USER_PER_MIN, 1200),
    rateIpPerMin: asInt(env.RATE_IP_PER_MIN, 600),

    powDifficultyBase: asInt(env.POW_DIFFICULTY_BASE, 16),
    powDifficultyStep: asInt(env.POW_DIFFICULTY_STEP, 2),
    powDifficultyMax: asInt(env.POW_DIFFICULTY_MAX, 24),
    powChallengeTtlSec: asInt(env.POW_CHALLENGE_TTL, 300),
    powTokenTtlSec: asInt(env.POW_TOKEN_TTL, 300),

    loginFailWindowSec: asInt(env.LOGIN_FAIL_WINDOW, 600),
    loginFailThreshold: asInt(env.LOGIN_FAIL_THRESHOLD, 5),
    ipBanThreshold: asInt(env.IP_BAN_THRESHOLD, 10),
    ipBanBaseSec: asInt(env.IP_BAN_BASE_SECONDS, 3600),
    ipBanMultiplier: asInt(env.IP_BAN_MULTIPLIER, 2),
    ipBanMaxSec: asInt(env.IP_BAN_MAX_SECONDS, 86400),

    auditRetentionDays: asInt(env.AUDIT_RETENTION_DAYS, 90),

    adminInitialPassword: env.ADMIN_INITIAL_PASSWORD?.trim() || null,
    isDev: env.NODE_ENV !== 'production',
  };
}

export const config: AapConfig = loadConfig();
