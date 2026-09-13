/**
 * Drizzle schema — SQLite 方言起步。
 *
 * 设计要点：
 * - 统一 users 表（kind 列区分 local/oidc），相对参考实现的双表是刻意改进：
 *   M2 OIDC 共表后彻底消除「仅按 uid 隔离会同号串号」问题；对外身份头仍按
 *   (kind, uid) 契约（shared.IDENTITY_*）。
 * - 会话只存 token 的 SHA-256 哈希，DB 泄露也不能伪造会话。
 * - W1+W2 首批迁移：settings / users / local_credentials / sessions /
 *   login_attempts / ip_bans / pow_* / audit_logs。
 */
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 'local' | 'oidc'（M2） */
    kind: text('kind').notNull().default('local'),
    /** local 唯一；oidc 为 null */
    username: text('username'),
    /** OIDC IdP 的 subject（稳定标识，唯一；local 为 null） */
    subject: text('subject'),
    email: text('email'),
    phone: text('phone'),
    name: text('name').notNull().default(''),
    avatar: text('avatar'),
    /** 'admin' | 'user'（M1 简化 RBAC；细粒度角色后继按需扩表） */
    role: text('role').notNull().default('user'),
    /** 'active' | 'disabled' | 'deletion_pending'（注销冷静期） */
    status: text('status').notNull().default('active'),
    /** 'free' | 'member'（M3 计费接入，M1 恒 free） */
    plan: text('plan').notNull().default('free'),
    mfaEnabled: integer('mfa_enabled', { mode: 'boolean' }).notNull().default(false),
    mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
    deletionRequestedAt: integer('deletion_requested_at'),
    createdAt: integer('created_at').notNull(),
    lastLoginAt: integer('last_login_at'),
    lastIp: text('last_ip'),
  },
  (t) => [
    uniqueIndex('users_username_uq').on(t.username),
    // 邮箱/手机唯一（A2：邮箱或手机号唯一）；允许多个 NULL（OIDC 用户等）
    uniqueIndex('users_email_uq')
      .on(t.email)
      .where(sql`email IS NOT NULL`),
    uniqueIndex('users_phone_uq')
      .on(t.phone)
      .where(sql`phone IS NOT NULL`),
    uniqueIndex('users_subject_uq')
      .on(t.subject)
      .where(sql`subject IS NOT NULL`),
  ],
);

export const localCredentials = sqliteTable('local_credentials', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tokenHash: text('token_hash').notNull().unique(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'password_ok' | 'mfa_pending' | 'full'（登录状态机，W4） */
    authState: text('auth_state').notNull().default('full'),
    /** 步升认证到期时间（敏感操作重验一次因子，5 分钟复用窗口） */
    stepUpUntil: integer('step_up_until'),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const loginAttempts = sqliteTable(
  'login_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ip: text('ip').notNull(),
    /** 账号键：'local:<username>'（oidc 后续 'oidc:<subject>'） */
    userKey: text('user_key').notNull(),
    success: integer('success', { mode: 'boolean' }).notNull(),
    reason: text('reason'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('login_attempts_ip_idx').on(t.ip, t.createdAt),
    index('login_attempts_user_idx').on(t.userKey, t.createdAt),
  ],
);

export const ipBans = sqliteTable('ip_bans', {
  ip: text('ip').primaryKey(),
  bannedUntil: integer('banned_until').notNull(),
  /** 累犯计数：每次到期后再犯 +1，封禁时长 = base * multiplier^repeat */
  repeatCount: integer('repeat_count').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const powChallenges = sqliteTable('pow_challenges', {
  id: text('id').primaryKey(),
  seed: text('seed').notNull(),
  difficulty: integer('difficulty').notNull(),
  ip: text('ip').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const powTokens = sqliteTable('pow_tokens', {
  token: text('token').primaryKey(),
  ip: text('ip').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    actor: text('actor').notNull(),
    ip: text('ip'),
    action: text('action').notNull(),
    /** JSON 序列化的明细 */
    detail: text('detail'),
  },
  (t) => [index('audit_logs_ts_idx').on(t.ts)],
);

// ---------- A2：注册体系 ----------

/** 验证码（6 位、5 分钟、哈希存储、单次有效） */
export const verificationCodes = sqliteTable(
  'verification_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 'email' | 'phone'（M1 首发邮件；phone 为短信通道预留） */
    channel: text('channel').notNull(),
    target: text('target').notNull(),
    /** 'register' | 'reset' | 'bind' */
    purpose: text('purpose').notNull(),
    /** sha256(salt:code)，salt:hash 存本列 */
    codeHash: text('code_hash').notNull(),
    ip: text('ip'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    consumedAt: integer('consumed_at'),
  },
  (t) => [index('verification_codes_target_idx').on(t.channel, t.target, t.createdAt)],
);

/** 待激活注册（验证邮箱/手机通过后才建 users 行；废弃 N 天清理） */
export const registrations = sqliteTable(
  'registrations',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    email: text('email'),
    phone: text('phone'),
    inviteCode: text('invite_code'),
    ip: text('ip'),
    /** 验证码尝试次数（≥5 作废整个注册） */
    attempts: integer('attempts').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('registrations_created_idx').on(t.createdAt)],
);

/** 邀请码（注册开关第三档；管理员签发，单次使用） */
export const inviteCodes = sqliteTable('invite_codes', {
  code: text('code').primaryKey(),
  createdBy: integer('created_by'),
  note: text('note'),
  usedBy: integer('used_by'),
  usedAt: integer('used_at'),
  createdAt: integer('created_at').notNull(),
});

// ---------- B4：应用注册 ----------

export const apps = sqliteTable('apps', {
  id: text('id').primaryKey(), // [a-z0-9][a-z0-9-]*，即 /app/<id>/ 前缀
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  icon: text('icon'),
  category: text('category').notNull().default('未分类'),
  /** 'public' 公开 | 'login' 需登录 | 'restricted' 指定分组与账号 | 'private' 仅归属者 */
  visibility: text('visibility').notNull().default('login'),
  /** 应用形态：upstream 反代上游 | html 门户托管的静态页（简单 HTML / .neon-aap html 包） */
  kind: text('kind').notNull().default('upstream'),
  /** 归属者（用户自建应用默认私有可见的依据；管理员创建 = 该管理员 id） */
  ownerUserId: integer('owner_user_id'),
  /** 是否向上游注入签名身份头（X-AAP-Identity） */
  passUser: integer('pass_user', { mode: 'boolean' }).notNull().default(false),
  /** 上游地址 http(s)://host[:port]/path?query（凭据不写这里，走 urlSecret） */
  upstream: text('upstream').notNull(),
  /** urlSecret 加密落盘：query 型 'token=xxx' / path 型 '__path__=/chat/xxx' */
  urlSecretEnc: text('url_secret_enc'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  sort: integer('sort').notNull().default(0),
  /** 'ok' | 'down' | 'unknown'（管理端状态仪表卡） */
  healthState: text('health_state').notNull().default('unknown'),
  lastProbeAt: integer('last_probe_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// ---------- 用户分组（会员等级 / 自定义组；应用可见性的目标集合） ----------

export const userGroups = sqliteTable('user_groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  note: text('note').notNull().default(''),
  createdAt: integer('created_at').notNull(),
});

export const userGroupMembers = sqliteTable(
  'user_group_members',
  {
    groupId: integer('group_id')
      .notNull()
      .references(() => userGroups.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

/** 应用可见性 ACL（visibility=restricted 时生效：任一命中即可见；两者皆空 = 全部登录用户） */
export const appAcl = sqliteTable('app_acl', {
  appId: text('app_id')
    .primaryKey()
    .references(() => apps.id, { onDelete: 'cascade' }),
  allowGroupIds: text('allow_group_ids').notNull().default('[]'), // JSON number[]
  allowUserIds: text('allow_user_ids').notNull().default('[]'), // JSON number[]
});

// ---------- A3：MFA ----------

/** TOTP 密钥（AES-256-GCM 加密落盘；±1 窗口 + 计数器重放拒绝） */
export const totpSecrets = sqliteTable('totp_secrets', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** 加密后的 base32 密钥（secrets 加密见 lib/cryptoSecrets.ts） */
  secretEnc: text('secret_enc').notNull(),
  /** 值 = TOTP 周期步数（30s 一步）；重放拒绝：只接受 > 此值的匹配 */
  lastUsedCounter: integer('last_used_counter').notNull().default(-1),
  /** enroll 未确认前不生效 */
  confirmed: integer('confirmed', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
});

/** 恢复码（10 枚、哈希存储、一枚一用） */
export const recoveryCodes = sqliteTable(
  'recovery_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: integer('used_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
);

/** Passkey 凭据（二次因子 + 无密码主登录双角色；多凭据） */
export const passkeys = sqliteTable(
  'passkeys',
  {
    /** WebAuthn credential ID（base64url） */
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(), // base64url
    counter: integer('counter').notNull().default(0),
    transports: text('transports'), // JSON 数组
    deviceType: text('device_type'),
    backedUp: integer('backedUp', { mode: 'boolean' }).notNull().default(false),
    nickname: text('nickname').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [index('passkeys_user_idx').on(t.userId)],
);

// ---------- C：LLM 网关（M2） ----------

/** 上游（OpenAI 兼容端点；真实 key 加密落盘，永不下发） */
export const llmUpstreams = sqliteTable('llm_upstreams', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(), // 如 https://dashscope.aliyuncs.com/compatible-mode/v1
  apiKeyEnc: text('api_key_enc').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
});

/** 模型路由：公开模型名 → 上游实际模型；同 model 多行 = failover 候选（priority 小者优先，同优先级按 weight 加权） */
export const llmRoutes = sqliteTable(
  'llm_routes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    model: text('model').notNull(), // 应用请求里的 model 名（公开目录名）
    upstreamId: integer('upstream_id')
      .notNull()
      .references(() => llmUpstreams.id, { onDelete: 'cascade' }),
    upstreamModel: text('upstream_model').notNull(), // 上游侧真实模型名
    multiplier: integer('multiplier').notNull().default(100), // 计费倍率（千分比，100 = 1:1），M3 定价沿用
    priority: integer('priority').notNull().default(100),
    weight: integer('weight').notNull().default(100),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('llm_routes_model_idx').on(t.model)],
);

/** 网关凭据（应用级；只存 SHA-256，明文仅创建时展示一次；可吊销可限额） */
export const llmAppTokens = sqliteTable(
  'llm_app_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tokenHash: text('token_hash').notNull().unique(),
    appId: text('app_id').notNull(), // apps.id 或外部应用标识
    name: text('name').notNull().default(''),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    perMinuteLimit: integer('per_minute_limit'), // 应用级限流（请求/分），null = 默认
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [index('llm_tokens_app_idx').on(t.appId)],
);

/** 用量/调额账本（append-only，只记不判；余额 = SUM(delta)） */
export const llmLedger = sqliteTable(
  'llm_ledger',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    userId: integer('user_id'), // null = 纯应用级调用（无用户归因）
    appId: text('app_id'),
    kind: text('kind').notNull(), // 'usage' | 'grant' | 'adjust'
    model: text('model'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    /** 有符号变动量（usage 为负；grant/adjust 为正）；余额 = SUM(delta) */
    delta: integer('delta').notNull(),
    latencyMs: integer('latency_ms'),
    status: text('status').notNull().default('ok'), // usage 行：ok | error
    requestId: text('request_id'),
    note: text('note'),
  },
  (t) => [
    index('llm_ledger_user_idx').on(t.userId, t.ts),
    index('llm_ledger_app_idx').on(t.appId, t.ts),
  ],
);

/** 余额缓存（C6 预检闸门；由结算/事件失效重算，非账本） */
export const llmBalanceCache = sqliteTable('llm_balance_cache', {
  userId: integer('user_id').primaryKey(),
  balance: integer('balance').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** OIDC 登录状态（state/nonce/PKCE，一次性） */
export const oidcStates = sqliteTable('oidc_states', {
  state: text('state').primaryKey(),
  nonce: text('nonce').notNull(),
  codeVerifier: text('code_verifier').notNull(),
  ip: text('ip'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
