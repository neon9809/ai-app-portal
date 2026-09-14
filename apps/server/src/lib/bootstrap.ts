/**
 * 首次初始化（F3，Docker 形态的种子逻辑）：users 为空时创建初始管理员——
 * 随机密码（或 ADMIN_INITIAL_PASSWORD）打印容器日志 + 写 data/ 一次性凭据
 * 文件（0600）；管理员首次登录（强制改密流程）时删除该文件。
 * FPK 形态的 NAS 管理员免密通道在 W10 落地，最终收敛到同一 checklist。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { config } from '../config/index.js';
import { getDb } from '../db/index.js';
import { localCredentials, trustedSigningKeys, users } from '../db/schema.js';
import { generatePassword, hashPassword } from './passwords.js';
import { audit } from './audit.js';

export const CREDENTIALS_FILE = 'admin-credentials.txt';

function credentialsPath(): string {
  return path.join(config.dataDir, CREDENTIALS_FILE);
}

export function userCount(): number {
  return getDb().select({ n: sql<number>`count(*)` }).from(users).get()?.n ?? 0;
}

export function adminCount(): number {
  return getDb().select({ n: sql<number>`count(*)` }).from(users).where(sql`role = 'admin'`).get()?.n ?? 0;
}

/** 首启引导；幂等（已有用户则跳过） */
export function ensureInitialAdmin(): void {
  if (userCount() > 0) return;

  const username = (process.env.ADMIN_USERNAME?.trim() || 'admin').toLowerCase();
  if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) {
    console.error(`[bootstrap] ADMIN_USERNAME 非法（3-64 位字母数字_.-）：${username}，跳过引导`);
    return;
  }
  const password = config.adminInitialPassword ?? generatePassword(12);

  const info = getDb()
    .insert(users)
    .values({
      kind: 'local',
      username,
      name: '管理员',
      role: 'admin',
      status: 'active',
      mustChangePassword: true, // F3：初始密码登录 → 强制改密 → 强制绑 MFA → checklist
      createdAt: Date.now(),
    })
    .run();
  void writeLocalCredentials(Number(info.lastInsertRowid), password);

  // 凭据落盘（0600）+ 打印日志
  const content = [
    '=== AI应用门户 初始管理员凭据（一次性，首次登录后本文件自动删除） ===',
    `地址: http://localhost:${config.port}`,
    `用户名: ${username}`,
    `密码: ${password}`,
    '首次登录后请立即设置新密码并绑定 MFA。',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(credentialsPath(), content, { mode: 0o600 });
  } catch (err) {
    console.error('[bootstrap] 凭据文件写入失败:', err);
  }
  console.log(content);
  audit('system', null, 'bootstrap.admin.created', { username, via: config.adminInitialPassword ? 'env' : 'random' });
}

/** 管理员首次登录（进入强制改密流程）后删除一次性凭据文件 */
export function disposeCredentialsFile(): void {
  try {
    const p = credentialsPath();
    if (fs.existsSync(p)) {
      fs.rmSync(p);
      console.log('[bootstrap] 一次性凭据文件已删除');
    }
  } catch {
    // 删除失败不影响登录
  }
}

/** 官方签名公钥内置信任（G4）：AAP_OFFICIAL_SIGN_PUBKEY（base64，32 字节 Ed25519 公钥）
 *  设置时种入信任列表并标记 builtin（设置页/接口不可删）；不设置则跳过。 */
export function seedOfficialSigningKey(): void {
  const b64 = process.env.AAP_OFFICIAL_SIGN_PUBKEY?.trim();
  if (!b64) return;
  let raw: Buffer;
  try {
    raw = Buffer.from(b64, 'base64');
  } catch {
    console.error('[bootstrap] AAP_OFFICIAL_SIGN_PUBKEY 不是合法 base64，跳过内置信任');
    return;
  }
  if (raw.length !== 32) {
    console.error('[bootstrap] AAP_OFFICIAL_SIGN_PUBKEY 必须是 32 字节 Ed25519 公钥（base64），跳过内置信任');
    return;
  }
  const keyId = 'SHA256:' + createHash('sha256').update(raw).digest('hex').slice(0, 16);
  getDb()
    .insert(trustedSigningKeys)
    .values({
      keyId,
      name: process.env.AAP_OFFICIAL_SIGNER_NAME?.trim() || '官方发布',
      publicKey: raw.toString('base64'),
      builtin: true,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
  console.log(`[bootstrap] 官方签名公钥已内置信任: ${keyId}`);
}

/** 创建/更新本地凭据（注册、改密、引导共用） */
export async function writeLocalCredentials(userId: number, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  getDb()
    .insert(localCredentials)
    .values({ userId, passwordHash, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: localCredentials.userId, set: { passwordHash, updatedAt: Date.now() } })
    .run();
}

export function getLocalPasswordHash(userId: number): string | null {
  return (
    getDb()
      .select({ h: localCredentials.passwordHash })
      .from(localCredentials)
      .where(eq(localCredentials.userId, userId))
      .get()?.h ?? null
  );
}
