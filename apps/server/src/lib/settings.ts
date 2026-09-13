/**
 * 运行时配置（settings 表）——移植自参考实现 lib/settings.js 模式：
 * env 只作首次种子的初值；后台改值即时生效（getSetting 运行时读）。
 * 管理端展示用 SETTING_DEFS 的 desc（E2：一句话说明）与 advanced（高级项折叠）。
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { config } from '../config/index.js';
import { getDb } from '../db/index.js';
import { settings } from '../db/schema.js';

export interface SettingDef {
  type: 'string' | 'int' | 'bool';
  desc: string;
  /** 首次种子的初值（通常取自 env） */
  initial: () => string;
  /** 管理端只写不读，回显掩码 */
  secret?: boolean;
  /** 高级项：管理后台默认折叠（E2-③） */
  advanced?: boolean;
  /** 「默认值即可跑」标注（E2-③） */
  defaultsWork?: boolean;
}

export const SETTING_DEFS: Record<string, SettingDef> = {
  // ---- 品牌（A1，数据化品牌，默认纯净） ----
  SITE_NAME: { type: 'string', desc: '站点名称', initial: () => 'AI应用门户', defaultsWork: true },
  SITE_TAGLINE: {
    type: 'string',
    desc: '站点标语（门户副标题）',
    initial: () => '统一入口 · 安全发布 · 模型托底',
    defaultsWork: true,
  },
  LOGO: { type: 'string', desc: 'Logo 图片（data URI 或 /uploads 路径，留空用站名文字）', initial: () => '', defaultsWork: true },
  THEME_ID: {
    type: 'string',
    desc: `内置主题 id（${'ocean/aurora/forest/sunset/sakura/graphite'}）`,
    initial: () => 'ocean',
    defaultsWork: true,
  },
  ACCENT_COLOR: { type: 'string', desc: '自定义强调色（#RRGGBB，留空用主题默认）', initial: () => '', defaultsWork: true },
  FOOTER_TEXT: { type: 'string', desc: '页脚文案', initial: () => '', defaultsWork: true },
  ICP_NUMBER: { type: 'string', desc: 'ICP 备案号（自动带工信部查询链接，留空不显示）', initial: () => '', defaultsWork: true },
  POLICE_NUMBER: { type: 'string', desc: '公安备案号（自动带公安备案查询链接，留空不显示）', initial: () => '', defaultsWork: true },

  // ---- 注册与账号（A2） ----
  REGISTRATION_MODE: {
    type: 'string',
    desc: '注册开关：closed 关闭 / open 开放 / invite 开放+邀请码（默认关闭）',
    initial: () => 'closed',
    defaultsWork: true,
  },
  MAX_ACCOUNTS_PER_IP_24H: { type: 'int', desc: '同一 IP 24 小时内最多注册账号数', initial: () => '5', defaultsWork: true },
  REGISTRATION_PENDING_TTL_DAYS: {
    type: 'int',
    desc: '废弃注册（未完成验证）N 天后清理',
    initial: () => '7',
    defaultsWork: true,
    advanced: true,
  },

  // ---- 安全栈调优（默认值即可跑） ----
  AAP_SIGN_SECRET: {
    type: 'string',
    desc: '身份注入头 HMAC 签名密钥（应用侧验签用；泄露需轮换）',
    initial: () => process.env.AAP_SIGN_SECRET?.trim() || randomBytes(32).toString('hex'),
    secret: true,
    advanced: true,
  },
  SESSION_TTL: { type: 'int', desc: '会话有效期（秒）', initial: () => String(config.sessionTtlSec), defaultsWork: true, advanced: true },
  POW_DIFFICULTY_BASE: { type: 'int', desc: 'PoW 基础难度（前导零位数）', initial: () => String(config.powDifficultyBase), defaultsWork: true, advanced: true },
  POW_DIFFICULTY_STEP: { type: 'int', desc: 'PoW 难度步进（每超阈值失败数 +2）', initial: () => String(config.powDifficultyStep), defaultsWork: true, advanced: true },
  POW_DIFFICULTY_MAX: { type: 'int', desc: 'PoW 难度上限（保证浏览器可解）', initial: () => String(config.powDifficultyMax), defaultsWork: true, advanced: true },
  POW_CHALLENGE_TTL: { type: 'int', desc: 'PoW 挑战有效期（秒）', initial: () => String(config.powChallengeTtlSec), defaultsWork: true, advanced: true },
  POW_TOKEN_TTL: { type: 'int', desc: 'PoW 凭证有效期（秒）', initial: () => String(config.powTokenTtlSec), defaultsWork: true, advanced: true },
  LOGIN_FAIL_WINDOW: { type: 'int', desc: '登录失败计数窗口（秒）', initial: () => String(config.loginFailWindowSec), defaultsWork: true, advanced: true },
  LOGIN_FAIL_THRESHOLD: { type: 'int', desc: '窗口内失败多少次触发 PoW / 封禁计数', initial: () => String(config.loginFailThreshold), defaultsWork: true, advanced: true },
  IP_BAN_THRESHOLD: { type: 'int', desc: '窗口内失败多少次自动封禁 IP', initial: () => String(config.ipBanThreshold), defaultsWork: true, advanced: true },
  IP_BAN_BASE_SECONDS: { type: 'int', desc: '封禁基础时长（秒）', initial: () => String(config.ipBanBaseSec), defaultsWork: true, advanced: true },
  IP_BAN_MULTIPLIER: { type: 'int', desc: '累犯封禁时长倍数（2 = 翻倍）', initial: () => String(config.ipBanMultiplier), defaultsWork: true, advanced: true },
  IP_BAN_MAX_SECONDS: { type: 'int', desc: '封禁时长上限（秒）', initial: () => String(config.ipBanMaxSec), defaultsWork: true, advanced: true },
  AUDIT_RETENTION_DAYS: { type: 'int', desc: '审计日志保留天数', initial: () => String(config.auditRetentionDays), defaultsWork: true, advanced: true },
  RATE_USER_PER_MIN: { type: 'int', desc: '应用网关限流：每用户请求/分', initial: () => String(config.rateUserPerMin), defaultsWork: true, advanced: true },
  RATE_IP_PER_MIN: { type: 'int', desc: '应用网关限流：每 IP 兜底请求/分', initial: () => String(config.rateIpPerMin), defaultsWork: true, advanced: true },
  PROXY_TIMEOUT: { type: 'int', desc: '应用网关上游超时（秒，仅覆盖首字节/HTML 拉取，不断流式连接）', initial: () => String(config.proxyTimeoutSec), defaultsWork: true, advanced: true },

  // ---- 人机验证（可选，填 key 即启用，默认 PoW 兜底） ----
  TURNSTILE_SITE_KEY: { type: 'string', desc: 'Cloudflare Turnstile 站点密钥（留空则只用 PoW）', initial: () => '', defaultsWork: true },
  TURNSTILE_SECRET_KEY: { type: 'string', desc: 'Turnstile 服务端密钥', initial: () => '', secret: true, defaultsWork: true },

  // ---- 验证码通道（A2，SMTP 首发配置） ----
  SMTP_HOST: { type: 'string', desc: 'SMTP 服务器（注册/找回/绑定邮箱验证码发信）', initial: () => '', defaultsWork: false },
  SMTP_PORT: { type: 'int', desc: 'SMTP 端口（465/587）', initial: () => '465', defaultsWork: false },
  SMTP_USER: { type: 'string', desc: 'SMTP 用户名', initial: () => '', defaultsWork: false },
  SMTP_PASS: { type: 'string', desc: 'SMTP 密码/授权码', initial: () => '', secret: true, defaultsWork: false },
  SMTP_FROM: { type: 'string', desc: '发件人（如 "AI应用门户 <no-reply@example.com>"）', initial: () => '', defaultsWork: false },
};

/** 首启把全部默认值种入 settings（INSERT OR IGNORE，env 只作初值不覆盖已存值） */
export function seedSettings(): void {
  const db = getDb();
  const now = Date.now();
  for (const [key, def] of Object.entries(SETTING_DEFS)) {
    db.insert(settings)
      .values({ key, value: def.initial(), updatedAt: now })
      .onConflictDoNothing()
      .run();
  }
}

export function getSetting(key: string): string | null {
  const row = getDb().select().from(settings).where(eq(settings.key, key)).get();
  return row?.value ?? null;
}

export function getSettingInt(key: string, fallback: number): number {
  const v = getSetting(key);
  const n = v === null || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function getSettingBool(key: string, fallback: boolean): boolean {
  const v = getSetting(key);
  if (v === null || v.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

export function setSetting(key: string, value: string): void {
  getDb()
    .insert(settings)
    .values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: Date.now() } })
    .run();
}

/** 管理端列表视图：secret 回显掩码（只写不读） */
export function listSettingsForAdmin(): Array<{ key: string; value: string; def: SettingDef }> {
  return Object.entries(SETTING_DEFS).map(([key, def]) => ({
    key,
    value: def.secret ? '********' : (getSetting(key) ?? ''),
    def,
  }));
}

/** 管理端写入：空值或掩码 = 不修改（secret 只写不读） */
export function updateSettingFromAdmin(key: string, value: string): void {
  const def = SETTING_DEFS[key];
  if (!def) throw new Error(`未知配置项: ${key}`);
  if (def.secret && (value === '' || value === '********')) return;
  setSetting(key, value);
}
