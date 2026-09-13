/**
 * MFA 核心（A3）：TOTP（RFC 6238，±1 窗口、计数器重放拒绝）+
 * 恢复码（10 枚、哈希存储、一枚一用）。
 * 策略：admin 强制不可关（无其他因子时禁止全部关闭）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { generate, generateSecret, generateURI } from 'otplib';
import { getDb } from '../db/index.js';
import { passkeys, recoveryCodes, totpSecrets, users } from '../db/schema.js';
import { decryptSecret, encryptSecret } from './cryptoSecrets.js';
import { HttpError } from './httpError.js';
import { audit } from './audit.js';

const TOTP_STEP_SEC = 30;

/** 生成 base32 TOTP 密钥 + otpauth URI（未确认态入库；前端把 URI 渲染成二维码） */
export function enrollTotp(userId: number, siteName: string, username: string): {
  secret: string;
  otpauthUri: string;
} {
  const existing = getDb().select().from(totpSecrets).where(eq(totpSecrets.userId, userId)).get();
  if (existing?.confirmed) {
    throw new HttpError(409, 'TOTP_ALREADY_ENROLLED', 'TOTP 已绑定；先解绑再重新绑定');
  }
  const secret = generateSecret();
  const otpauthUri = generateURI({ issuer: siteName, label: username, secret });
  if (existing) {
    getDb()
      .update(totpSecrets)
      .set({ secretEnc: encryptSecret(secret), lastUsedCounter: -1, confirmed: false })
      .where(eq(totpSecrets.userId, userId))
      .run();
  } else {
    getDb()
      .insert(totpSecrets)
      .values({ userId, secretEnc: encryptSecret(secret), confirmed: false, createdAt: Date.now() })
      .run();
  }
  return { secret, otpauthUri };
}

export type OtpVerifyOk = { ok: true; counter: number } | { ok: false; error: string };

/**
 * 校验 TOTP：RFC 6238 ±1 时间步窗口；重放拒绝——
 * 匹配的计数器必须大于已用计数器（防同一窗口的码二次使用）。
 * 实现方式：对 [C-1, C, C+1] 三个候选窗口自算期望码比对（不依赖
 * otplib verify 的 guardrail，保证「重放」与「无效」语义分明）。
 */
export async function verifyTotpToken(secret: string, token: string, lastUsedCounter: number): Promise<OtpVerifyOk> {
  const target = token.trim();
  const current = Math.floor(Date.now() / 1000 / TOTP_STEP_SEC);
  for (const delta of [0, -1, 1] as const) {
    const counter = current + delta;
    const expected = await generate({ secret, epoch: counter * TOTP_STEP_SEC });
    if (expected === target) {
      if (counter <= lastUsedCounter) return { ok: false, error: 'TOTP_REPLAYED' };
      return { ok: true, counter };
    }
  }
  return { ok: false, error: 'TOTP_INVALID' };
}

/** 确认绑定：验证一次即时码 → confirmed + mfaEnabled + 发 10 枚恢复码 */
export async function confirmTotp(userId: number, token: string): Promise<string[]> {
  const row = getDb().select().from(totpSecrets).where(eq(totpSecrets.userId, userId)).get();
  if (!row) throw new HttpError(404, 'TOTP_NOT_ENROLLED', '请先生成绑定密钥');
  if (row.confirmed) throw new HttpError(409, 'TOTP_ALREADY_ENROLLED', 'TOTP 已绑定');
  const secret = decryptSecret(row.secretEnc);
  const v = await verifyTotpToken(secret, token.trim(), row.lastUsedCounter);
  if (!v.ok) throw new HttpError(400, v.error, v.error === 'TOTP_REPLAYED' ? '验证码已被使用' : '验证码错误');

  getDb()
    .update(totpSecrets)
    .set({ confirmed: true, lastUsedCounter: v.counter })
    .where(eq(totpSecrets.userId, userId))
    .run();
  getDb().update(users).set({ mfaEnabled: true }).where(eq(users.id, userId)).run();
  const codes = generateRecoveryCodes(userId);
  audit(`user:${userId}`, null, 'mfa.totp.confirmed', {});
  return codes;
}

/** 用 TOTP/恢复码做登录验证（password_ok → full）；返回是否为恢复码登录 */
export async function verifyTotpForLogin(userId: number, token: string, ip: string | null): Promise<
  { viaRecovery: false } | { viaRecovery: true }
> {
  const row = getDb().select().from(totpSecrets).where(eq(totpSecrets.userId, userId)).get();
  if (!row?.confirmed) throw new HttpError(400, 'TOTP_NOT_ENROLLED', 'TOTP 未绑定');

  const secret = decryptSecret(row.secretEnc);
  const v = await verifyTotpToken(secret, token.trim(), row.lastUsedCounter);
  if (v.ok) {
    getDb().update(totpSecrets).set({ lastUsedCounter: v.counter }).where(eq(totpSecrets.userId, userId)).run();
    audit(`user:${userId}`, ip, 'mfa.totp.verify', { context: 'login' });
    return { viaRecovery: false };
  }
  // 恢复码兜底（一枚一用）
  const used = useRecoveryCode(userId, token.trim());
  if (used) {
    audit(`user:${userId}`, ip, 'mfa.recovery.used', { context: 'login' });
    return { viaRecovery: true };
  }
  // 两路皆失败：保留原始语义（TOTP_REPLAYED = 码有效但已被消费）
  throw new HttpError(
    400,
    v.error,
    v.error === 'TOTP_REPLAYED' ? '验证码已被使用，请等待下一个验证码' : '验证码错误',
  );
}

function recoveryHash(code: string): string {
  return createHash('sha256').update(`aap-recovery:${code.toUpperCase().trim()}`).digest('hex');
}

/** 生成 10 枚恢复码（明文只出现一次；重生成 = 作废旧码） */
export function generateRecoveryCodes(userId: number): string[] {
  const db = getDb();
  db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    // 格式 xxxx-xxxx（去易混淆字符）
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(8);
    let body = '';
    for (let j = 0; j < 8; j++) body += alphabet[bytes[j]! % alphabet.length];
    const code = `${body.slice(0, 4)}-${body.slice(4)}`;
    codes.push(code);
    db.insert(recoveryCodes)
      .values({ userId, codeHash: recoveryHash(code), createdAt: Date.now() })
      .run();
  }
  return codes;
}

/** 消费一枚恢复码（成功 = 用掉；返回是否命中） */
export function useRecoveryCode(userId: number, code: string): boolean {
  const db = getDb();
  const hash = recoveryHash(code);
  const row = db
    .select()
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), eq(recoveryCodes.codeHash, hash), isNull(recoveryCodes.usedAt)))
    .get();
  if (!row) return false;
  db.update(recoveryCodes).set({ usedAt: Date.now() }).where(eq(recoveryCodes.id, row.id)).run();
  return true;
}

/** 剩余可用恢复码数（管理页展示） */
export function remainingRecoveryCodes(userId: number): number {
  return (
    getDb()
      .select({ n: sql<number>`count(*)` })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
      .get()?.n ?? 0
  );
}

function passkeyCountFor(userId: number): number {
  return (
    getDb().select({ n: sql<number>`count(*)` }).from(passkeys).where(eq(passkeys.userId, userId)).get()?.n ?? 0
  );
}

/** 解绑 TOTP：admin 无其他因子（passkey）时拒绝（策略：admin 强制 MFA 不可关） */
export function disableTotp(userId: number, isAdmin: boolean): void {
  const row = getDb().select().from(totpSecrets).where(eq(totpSecrets.userId, userId)).get();
  if (!row) throw new HttpError(404, 'TOTP_NOT_ENROLLED', 'TOTP 未绑定');
  const pkCount = passkeyCountFor(userId);
  if (isAdmin && pkCount === 0) {
    throw new HttpError(403, 'MFA_REQUIRED_FOR_ADMIN', '管理员必须保留至少一种多因子；请先绑定 Passkey 再解绑 TOTP');
  }
  getDb().delete(totpSecrets).where(eq(totpSecrets.userId, userId)).run();
  getDb().delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
  if (pkCount === 0) {
    getDb().update(users).set({ mfaEnabled: false }).where(eq(users.id, userId)).run();
  }
  audit(`user:${userId}`, null, 'mfa.totp.disabled', {});
}

/** 是否已绑定并确认 TOTP */
export function totpConfirmed(userId: number): boolean {
  const row = getDb().select({ c: totpSecrets.confirmed }).from(totpSecrets).where(eq(totpSecrets.userId, userId)).get();
  return row?.c === true;
}
