/**
 * 本地账号口令哈希（scrypt，Node 内置）——移植自参考实现 lib/passwords.js。
 * 格式：scrypt$<salt>$<hash>
 *
 * verifyPassword 为异步实现，避免同步 scrypt 阻塞事件循环导致登录串行化；
 * dummyVerify 供「用户不存在」分支消耗等量 CPU，消除用户名枚举时序侧信道。
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';

const KEYLEN = 32;

// 进程内固定的哑盐：仅用于不存在用户的等时校验，不用于真实凭据
const DUMMY_SALT = randomBytes(16).toString('hex');

function scryptAsync(password: string, salt: string, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(String(password), salt, KEYLEN)).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/** 校验口令；格式非法时也执行一次哑 scrypt，保证响应时间与合法格式一致 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    await dummyVerify(password);
    return false;
  }
  const salt = parts[1]!;
  const hash = parts[2]!;
  const test = await scryptAsync(String(password), salt, KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  return test.length === expected.length && timingSafeEqual(test, expected);
}

/** 对不存在的用户执行一次等量 scrypt 计算（结果恒 false），防用户名枚举 */
export async function dummyVerify(password: string): Promise<boolean> {
  await scryptAsync(String(password), DUMMY_SALT, KEYLEN);
  return false;
}

/** 随机口令：无易混淆字符，便于人工抄录（Docker 首启初始密码用） */
export function generatePassword(len = 12): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = randomBytes(len);
  for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

/** 通用随机令牌（hex） */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** 会话 token 只存 SHA-256（DB 泄露也不能伪造会话） */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
