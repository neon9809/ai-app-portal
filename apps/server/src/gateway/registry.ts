/**
 * 应用注册表（B4）：DB 为唯一事实源，SQLite 本地读足够快（无网络），
 * 每次读取即拿到最新数据 → 管理 CRUD「保存即生效」天然成立。
 * urlSecret AES-256-GCM 加密落盘，转发时才解密拼入，绝不下发浏览器。
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { apps } from '../db/schema.js';
import { decryptSecret } from '../lib/cryptoSecrets.js';
import { appAcl } from '../db/schema.js';
import { userGroupIds } from '../lib/groups.js';

export type AppRow = typeof apps.$inferSelect;

export interface AppAcl {
  allowGroupIds: number[];
  allowUserIds: number[];
}

function aclOf(appId: string): AppAcl {
  const row = getDb().select().from(appAcl).where(eq(appAcl.appId, appId)).get();
  const parse = (v: string): number[] => {
    try {
      const arr = JSON.parse(v) as unknown;
      return Array.isArray(arr) ? arr.map(Number) : [];
    } catch {
      return [];
    }
  };
  return row
    ? { allowGroupIds: parse(row.allowGroupIds), allowUserIds: parse(row.allowUserIds) }
    : { allowGroupIds: [], allowUserIds: [] };
}

export function getAcl(appId: string): AppAcl {
  return aclOf(appId);
}

export function setAcl(appId: string, acl: AppAcl): void {
  getDb()
    .insert(appAcl)
    .values({ appId, allowGroupIds: JSON.stringify(acl.allowGroupIds), allowUserIds: JSON.stringify(acl.allowUserIds) })
    .onConflictDoUpdate({
      target: appAcl.appId,
      set: { allowGroupIds: JSON.stringify(acl.allowGroupIds), allowUserIds: JSON.stringify(acl.allowUserIds) },
    })
    .run();
}

export const PATH_SECRET_KEY = '__path__';

export interface UrlSecret {
  /** query 型：参数名；path 型：null */
  name: string | null;
  /** query 型：参数值；path 型：上游子路径（如 /chat/xxx） */
  value: string;
}

export function isSlug(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

export function listApps(): AppRow[] {
  return getDb().select().from(apps).orderBy(apps.sort, apps.id).all();
}

export function findApp(id: string): AppRow | null {
  return getDb().select().from(apps).where(eq(apps.id, id)).get() ?? null;
}

/** 解析 urlSecret 密文；未配置返回 null */
export function getUrlSecret(app: AppRow): UrlSecret | null {
  if (!app.urlSecretEnc) return null;
  try {
    const raw = decryptSecret(app.urlSecretEnc);
    if (raw.startsWith(PATH_SECRET_KEY + '=')) {
      return { name: null, value: raw.slice(PATH_SECRET_KEY.length + 1) };
    }
    const eqi = raw.indexOf('=');
    if (eqi <= 0) return null;
    return { name: raw.slice(0, eqi), value: raw.slice(eqi + 1) };
  } catch (err) {
    console.error(`[registry] app ${app.id} urlSecret 解密失败:`, err);
    return null;
  }
}

/** 管理员可见一切（含 private） */
function isAdminUser(user: { role: string } | null | undefined): boolean {
  return Boolean(user && user.role === 'admin');
}

/**
 * 可见性模型（P）：
 *  - public：全员（含匿名）
 *  - login：全部登录用户
 *  - restricted：登录 + 指定分组/指定账号任一命中；ACL 为空 = 全部登录用户；归属者与管理员始终可见
 *  - private：仅归属者（用户自建应用默认）
 * 审核门禁（G3/G4）：pending/rejected 的应用仅归属者与管理员可访问——
 * 否则已公开应用推未审新版即对全员生效（渗透测试 P1-6 实锤利用路径）。
 * reviewStatus='none' 视为免审（历史/管理员自建/官方签名通道外的默认态）。
 */
export function canAccess(
  app: AppRow,
  user: { id: number; authState: string; role: string } | null | undefined,
): boolean {
  if (isAdminUser(user)) return true;
  if ((app.reviewStatus === 'pending' || app.reviewStatus === 'rejected') &&
      !(user && user.authState === 'full' && app.ownerUserId === user.id)) {
    return false;
  }
  switch (app.visibility) {
    case 'public':
      return true;
    case 'login':
      return Boolean(user && user.authState === 'full');
    case 'private':
      return Boolean(user && user.authState === 'full' && app.ownerUserId === user.id);
    case 'restricted': {
      if (!user || user.authState !== 'full') return false;
      if (app.ownerUserId === user.id) return true;
      const acl = aclOf(app.id);
      if (acl.allowGroupIds.length === 0 && acl.allowUserIds.length === 0) return true;
      if (acl.allowUserIds.includes(user.id)) return true;
      const groupIds = userGroupIds(user.id);
      return acl.allowGroupIds.some((g) => groupIds.has(g));
    }
    default:
      return false;
  }
}

/** 门户卡片是否对该用户展示（private 且非归属者/管理员 → 隐藏；待审/驳回对非归属者同样隐藏） */
export function isVisibleInPortal(app: AppRow, user: { id: number; role: string } | null | undefined): boolean {
  if (isAdminUser(user)) return true;
  if ((app.reviewStatus === 'pending' || app.reviewStatus === 'rejected') && app.ownerUserId !== user?.id) {
    return false;
  }
  if (app.visibility !== 'private') return true;
  return Boolean(user && app.ownerUserId === user.id);
}
