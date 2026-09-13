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
  /** 面板分组（E2：配置按功能块分区，不糊成一团） */
  group: string;
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
  SITE_NAME: {
    group: '站点与品牌', type: 'string', desc: '站点名称', initial: () => 'AI应用门户', defaultsWork: true },
  SITE_TAGLINE: {
    group: '站点与品牌',
    type: 'string',
    desc: '站点标语（门户副标题）',
    initial: () => '统一入口 · 安全发布 · 模型托底',
    defaultsWork: true,
  },
  LOGO: {
    group: '站点与品牌', type: 'string', desc: 'Logo 图片（data URI 或 /uploads 路径，留空用站名文字）', initial: () => '', defaultsWork: true },
  THEME_ID: {
    group: '站点与品牌',
    type: 'string',
    desc: `内置主题 id（${'ocean/aurora/forest/sunset/sakura/graphite'}）`,
    initial: () => 'ocean',
    defaultsWork: true,
  },
  ACCENT_COLOR: {
    group: '站点与品牌', type: 'string', desc: '自定义强调色（#RRGGBB，留空用主题默认）', initial: () => '', defaultsWork: true },
  FOOTER_TEXT: {
    group: '站点与品牌', type: 'string', desc: '页脚文案', initial: () => '', defaultsWork: true },
  ICP_NUMBER: {
    group: '站点与品牌', type: 'string', desc: 'ICP 备案号（自动带工信部查询链接，留空不显示）', initial: () => '', defaultsWork: true },
  POLICE_NUMBER: {
    group: '站点与品牌', type: 'string', desc: '公安备案号（自动带公安备案查询链接，留空不显示）', initial: () => '', defaultsWork: true },

  // ---- 注册与账号（A2） ----
  REGISTRATION_MODE: {
    group: '注册与账号',
    type: 'string',
    desc: '注册开关：closed 关闭 / open 开放 / invite 开放+邀请码（默认关闭）',
    initial: () => 'closed',
    defaultsWork: true,
  },
  MAX_ACCOUNTS_PER_IP_24H: { group: '注册与账号', type: 'int', desc: '同一 IP 24 小时内最多注册账号数', initial: () => '5', defaultsWork: true },
  CODE_SEND_DAILY_LIMIT: {
    group: '注册与账号',
    type: 'int',
    desc: '同一邮箱/手机 24 小时内最多收到的验证码条数（防轰炸）',
    initial: () => '10',
    defaultsWork: true,
  },
  DELETION_COOLDOWN_DAYS: {
    group: '注册与账号',
    type: 'int',
    desc: '注销冷静期（天）：期内可撤回，到期数据匿名化',
    initial: () => '7',
    defaultsWork: true,
  },
  REGISTRATION_PENDING_TTL_DAYS: {
    group: '注册与账号',
    type: 'int',
    desc: '废弃注册（未完成验证）N 天后清理',
    initial: () => '7',
    defaultsWork: true,
    advanced: true,
  },

  // ---- 安全栈调优（默认值即可跑） ----
  POW_ENABLED: {
    group: '安全与限流', type: 'bool', desc: '登录失败超阈值后要求 PoW 工作量证明', initial: () => 'true', defaultsWork: true },
  AAP_SIGN_SECRET: {
    group: '安全与限流',
    type: 'string',
    desc: '身份注入头 HMAC 签名密钥（应用侧验签用；泄露需轮换）',
    initial: () => process.env.AAP_SIGN_SECRET?.trim() || randomBytes(32).toString('hex'),
    secret: true,
    advanced: true,
  },
  SESSION_TTL: {
    group: '安全与限流', type: 'int', desc: '会话有效期（秒）', initial: () => String(config.sessionTtlSec), defaultsWork: true, advanced: true },
  POW_DIFFICULTY_BASE: {
    group: '安全与限流', type: 'int', desc: 'PoW 基础难度（前导零位数）', initial: () => String(config.powDifficultyBase), defaultsWork: true, advanced: true },
  POW_DIFFICULTY_STEP: {
    group: '安全与限流', type: 'int', desc: 'PoW 难度步进（每超阈值失败数 +2）', initial: () => String(config.powDifficultyStep), defaultsWork: true, advanced: true },
  POW_DIFFICULTY_MAX: {
    group: '安全与限流', type: 'int', desc: 'PoW 难度上限（保证浏览器可解）', initial: () => String(config.powDifficultyMax), defaultsWork: true, advanced: true },
  POW_CHALLENGE_TTL: {
    group: '安全与限流', type: 'int', desc: 'PoW 挑战有效期（秒）', initial: () => String(config.powChallengeTtlSec), defaultsWork: true, advanced: true },
  POW_TOKEN_TTL: {
    group: '安全与限流', type: 'int', desc: 'PoW 凭证有效期（秒）', initial: () => String(config.powTokenTtlSec), defaultsWork: true, advanced: true },
  LOGIN_FAIL_WINDOW: {
    group: '安全与限流', type: 'int', desc: '登录失败计数窗口（秒）', initial: () => String(config.loginFailWindowSec), defaultsWork: true, advanced: true },
  LOGIN_FAIL_THRESHOLD: {
    group: '安全与限流', type: 'int', desc: '窗口内失败多少次触发 PoW / 封禁计数', initial: () => String(config.loginFailThreshold), defaultsWork: true, advanced: true },
  IP_BAN_THRESHOLD: {
    group: '安全与限流', type: 'int', desc: '窗口内失败多少次自动封禁 IP', initial: () => String(config.ipBanThreshold), defaultsWork: true, advanced: true },
  IP_BAN_BASE_SECONDS: {
    group: '安全与限流', type: 'int', desc: '封禁基础时长（秒）', initial: () => String(config.ipBanBaseSec), defaultsWork: true, advanced: true },
  IP_BAN_MULTIPLIER: {
    group: '安全与限流', type: 'int', desc: '累犯封禁时长倍数（2 = 翻倍）', initial: () => String(config.ipBanMultiplier), defaultsWork: true, advanced: true },
  IP_BAN_MAX_SECONDS: {
    group: '安全与限流', type: 'int', desc: '封禁时长上限（秒）', initial: () => String(config.ipBanMaxSec), defaultsWork: true, advanced: true },
  AUDIT_RETENTION_DAYS: {
    group: '安全与限流', type: 'int', desc: '审计日志保留天数', initial: () => String(config.auditRetentionDays), defaultsWork: true, advanced: true },
  MFA_STEPUP_TTL: {
    group: '安全与限流',
    type: 'int',
    desc: '步升认证有效期（秒）：重验一次因子后免重验窗口',
    initial: () => '300',
    defaultsWork: true,
    advanced: true,
  },
  RATE_USER_PER_MIN: {
    group: '应用网关', type: 'int', desc: '应用网关限流：每用户请求/分', initial: () => String(config.rateUserPerMin), defaultsWork: true, advanced: true },
  RATE_IP_PER_MIN: {
    group: '应用网关', type: 'int', desc: '应用网关限流：每 IP 兜底请求/分', initial: () => String(config.rateIpPerMin), defaultsWork: true, advanced: true },
  PROXY_TIMEOUT: {
    group: '应用网关', type: 'int', desc: '应用网关上游超时（秒，仅覆盖首字节/HTML 拉取，不断流式连接）', initial: () => String(config.proxyTimeoutSec), defaultsWork: true, advanced: true },

  // ---- HTTPS / 证书（B3；默认纯门户模式 = 不启 HTTPS，反代外置） ----
  ACME_DOMAIN: {
    group: '证书与 HTTPS', type: 'string', desc: 'ACME 签发域名（填写即启用自动 HTTPS，需 80 端口可达；留空走纯门户模式）', initial: () => '', defaultsWork: true },
  ACME_EMAIL: {
    group: '证书与 HTTPS', type: 'string', desc: 'ACME 账户邮箱（证书到期通知）', initial: () => '', defaultsWork: false },
  ACME_STAGING: {
    group: '证书与 HTTPS',
    type: 'bool',
    desc: '使用 Let\'s Encrypt 测试环境（避免触发正式环境限频，跑通后关闭）',
    initial: () => 'true',
    defaultsWork: true,
    advanced: true,
  },
  HTTPS_REDIRECT: {
    group: '证书与 HTTPS', type: 'bool', desc: 'HTTP 请求自动跳转 HTTPS（ACME 挑战路径除外）', initial: () => 'false', defaultsWork: true },

  // ---- 人机验证（可选，填 key 即启用，默认 PoW 兜底） ----
  TURNSTILE_SITE_KEY: {
    group: '人机验证', type: 'string', desc: 'Cloudflare Turnstile 站点密钥（留空则只用 PoW）', initial: () => '', defaultsWork: true },
  TURNSTILE_SECRET_KEY: {
    group: '人机验证', type: 'string', desc: 'Turnstile 服务端密钥', initial: () => '', secret: true, defaultsWork: true },

  // ---- 验证码通道（A2，SMTP 首发配置） ----
  SMTP_HOST: {
    group: '邮件通道（验证码发信）', type: 'string', desc: 'SMTP 服务器（注册/找回/绑定邮箱验证码发信）', initial: () => '', defaultsWork: false },
  SMTP_PORT: {
    group: '邮件通道（验证码发信）', type: 'int', desc: 'SMTP 端口（465/587）', initial: () => '465', defaultsWork: false },
  SMTP_USER: {
    group: '邮件通道（验证码发信）', type: 'string', desc: 'SMTP 用户名', initial: () => '', defaultsWork: false },
  SMTP_PASS: {
    group: '邮件通道（验证码发信）', type: 'string', desc: 'SMTP 密码/授权码', initial: () => '', secret: true, defaultsWork: false },
  SMTP_FROM: {
    group: '邮件通道（验证码发信）', type: 'string', desc: '发件人（如 "AI应用门户 <no-reply@example.com>"）', initial: () => '', defaultsWork: false },
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
