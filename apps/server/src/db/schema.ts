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
  (t) => [uniqueIndex('users_username_uq').on(t.username)],
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
