/** 路由层共享小工具 */
import type { PublicUser } from '@aap/shared';
import type { users } from '../db/schema.js';

type UserRow = typeof users.$inferSelect;

/** users 行 → 对外 PublicUser（剥除一切敏感字段） */
export function publicUserOf(row: UserRow): PublicUser {
  return {
    id: row.id,
    avatar: row.avatar ?? null,
    kind: row.kind === 'oidc' ? 'oidc' : 'local',
    username: row.username,
    email: row.email,
    phone: row.phone,
    name: row.name || row.username || `用户${row.id}`,
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.status as PublicUser['status'],
    mfaEnabled: row.mfaEnabled,
    plan: row.plan === 'member' ? 'member' : 'free',
    createdAt: row.createdAt,
  };
}
