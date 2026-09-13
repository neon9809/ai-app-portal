/**
 * 用户分组（P）：会员等级 / 自定义组。应用可见性（restricted）的目标集合；
 * M3 的会员等级直接落成分组（不同分组可见不同应用、配发不同 LLM 额度）。
 */
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { userGroupMembers, userGroups } from '../db/schema.js';
import { HttpError } from './httpError.js';

export interface GroupRow {
  id: number;
  name: string;
  note: string;
  createdAt: number;
  memberCount: number;
}

export function listGroups(): GroupRow[] {
  return getDb()
    .select({
      id: userGroups.id,
      name: userGroups.name,
      note: userGroups.note,
      createdAt: userGroups.createdAt,
      memberCount: sql<number>`(select count(*) from user_group_members m where m.group_id = ${userGroups.id})`,
    })
    .from(userGroups)
    .orderBy(sql`id`)
    .all();
}

export function createGroup(name: string, note: string): number {
  const exists = getDb().select({ id: userGroups.id }).from(userGroups).where(eq(userGroups.name, name)).get();
  if (exists) throw new HttpError(409, 'GROUP_EXISTS', '同名分组已存在');
  const info = getDb()
    .insert(userGroups)
    .values({ name: name.trim().slice(0, 64), note: note.slice(0, 200), createdAt: Date.now() })
    .run();
  return Number(info.lastInsertRowid);
}

export function updateGroup(id: number, patch: { name?: string; note?: string }): void {
  const set: Partial<typeof userGroups.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 64);
  if (patch.note !== undefined) set.note = patch.note.slice(0, 200);
  getDb().update(userGroups).set(set).where(eq(userGroups.id, id)).run();
}

export function deleteGroup(id: number): void {
  getDb().delete(userGroups).where(eq(userGroups.id, id)).run();
}

export function groupMemberIds(groupId: number): number[] {
  return getDb()
    .select({ userId: userGroupMembers.userId })
    .from(userGroupMembers)
    .where(eq(userGroupMembers.groupId, groupId))
    .all()
    .map((r) => r.userId);
}

/** 全量替换组成员（管理端多选保存） */
export function setGroupMembers(groupId: number, userIds: number[]): void {
  const db = getDb();
  db.delete(userGroupMembers).where(eq(userGroupMembers.groupId, groupId)).run();
  const now = Date.now();
  for (const uid of [...new Set(userIds)]) {
    db.insert(userGroupMembers).values({ groupId, userId: uid, createdAt: now }).run();
  }
}

/** 用户所属分组 id 集合（可见性判定用） */
export function userGroupIds(userId: number): Set<number> {
  return new Set(
    getDb()
      .select({ groupId: userGroupMembers.groupId })
      .from(userGroupMembers)
      .where(eq(userGroupMembers.userId, userId))
      .all()
      .map((r) => r.groupId),
  );
}
