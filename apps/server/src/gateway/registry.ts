/**
 * 应用注册表（B4）：DB 为唯一事实源，SQLite 本地读足够快（无网络），
 * 每次读取即拿到最新数据 → 管理 CRUD「保存即生效」天然成立。
 * urlSecret AES-256-GCM 加密落盘，转发时才解密拼入，绝不下发浏览器。
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { apps } from '../db/schema.js';
import { decryptSecret } from '../lib/cryptoSecrets.js';

export type AppRow = typeof apps.$inferSelect;

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

/** 访问策略三态（B4）：public 全员 / login 需登录 / member 需会员 */
export function canAccess(
  app: AppRow,
  user: { authState: string; plan: string } | null | undefined,
): boolean {
  switch (app.visibility) {
    case 'public':
      return true;
    case 'login':
      return Boolean(user && user.authState === 'full');
    case 'member':
      return Boolean(user && user.authState === 'full' && user.plan === 'member');
    default:
      return false;
  }
}
