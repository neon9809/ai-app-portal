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
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
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
    /** local 唯一；oidc 为 null（其唯一性走 subject，M2） */
    username: text('username'),
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
    /** 'email' | 'phone'（M1 首发邮件通道） */
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
  /** 'public' 公开 | 'login' 需登录 | 'member' 会员（M3 计费打通） */
  visibility: text('visibility').notNull().default('login'),
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
