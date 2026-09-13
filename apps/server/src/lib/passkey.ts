/**
 * Passkey（WebAuthn，A3）：@simplewebauthn/server 封装。
 * 双角色：已登录时的二次因子绑定；无密码主登录（discoverable credentials）。
 * 挑战存进程内（TTL 5 分钟）——单机部署语义；重启后需重新发起（可接受）。
 */
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { getDb } from '../db/index.js';
import { passkeys, users } from '../db/schema.js';
import { HttpError } from './httpError.js';
import { audit } from './audit.js';
import { getSetting } from './settings.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface ChallengeEntry {
  challenge: string;
  userId: number | null;
  purpose: 'register' | 'auth';
  expiresAt: number;
}

const challenges = new Map<string, ChallengeEntry>();

function putChallenge(key: string, entry: ChallengeEntry): void {
  for (const [k, v] of challenges) if (v.expiresAt <= Date.now()) challenges.delete(k);
  challenges.set(key, entry);
}

function takeChallenge(key: string): ChallengeEntry | null {
  const e = challenges.get(key);
  if (!e) return null;
  challenges.delete(key);
  if (e.expiresAt <= Date.now()) return null;
  return e;
}

/** rpID = 域名（不含端口）；origin = 浏览器实际访问的协议+host（含端口） */
export function rpInfo(req: Request): { rpID: string; rpName: string; origin: string } {
  const rpID = req.hostname;
  const hostHeader = (req.headers.host ?? req.hostname) as string;
  const proto = req.protocol;
  return { rpID, rpName: getSetting('SITE_NAME') || 'AI应用门户', origin: `${proto}://${hostHeader}` };
}

export interface PasskeyView {
  id: string;
  nickname: string;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
  deviceType: string | null;
}

export function listPasskeys(userId: number): PasskeyView[] {
  return getDb()
    .select()
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .all()
    .map((r) => ({
      id: r.id,
      nickname: r.nickname,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      backedUp: r.backedUp,
      deviceType: r.deviceType,
    }));
}

// ---------- 注册（绑定） ----------

export async function passkeyRegisterOptions(req: Request, userId: number, username: string) {
  const { rpID, rpName } = rpInfo(req);
  const existing = listPasskeys(userId);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: username,
    userID: new TextEncoder().encode(String(userId)),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });
  putChallenge(`reg:${userId}`, {
    challenge: options.challenge,
    userId,
    purpose: 'register',
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
  return options;
}

export async function passkeyRegisterVerify(
  req: Request,
  userId: number,
  nickname: string,
  response: RegistrationResponseJSON,
): Promise<PasskeyView> {
  const { rpID, origin } = rpInfo(req);
  const entry = takeChallenge(`reg:${userId}`);
  if (!entry) throw new HttpError(400, 'WEBAUTHN_CHALLENGE', '绑定会话已过期，请重新发起');

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: entry.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new HttpError(400, 'WEBAUTHN_VERIFY_FAILED', 'Passkey 校验失败');
  }
  const info = verification.registrationInfo as unknown as {
    credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] };
    credentialDeviceType: string;
    credentialBackedUp: boolean;
  };
  const id = info.credential.id;
  const publicKeyB64 = Buffer.from(info.credential.publicKey).toString('base64url');
  if (getDb().select().from(passkeys).where(eq(passkeys.id, id)).get()) {
    throw new HttpError(409, 'PASSKEY_EXISTS', '该 Passkey 已绑定过');
  }
  getDb()
    .insert(passkeys)
    .values({
      id,
      userId,
      publicKey: publicKeyB64,
      counter: info.credential.counter ?? 0,
      transports: info.credential.transports ? JSON.stringify(info.credential.transports) : null,
      deviceType: info.credentialDeviceType ?? null,
      backedUp: info.credentialBackedUp ?? false,
      nickname: nickname.slice(0, 64) || 'Passkey',
      createdAt: Date.now(),
    })
    .run();
  getDb().update(users).set({ mfaEnabled: true }).where(eq(users.id, userId)).run();
  audit(`user:${userId}`, req.clientIp ?? null, 'mfa.passkey.registered', { id });
  const view = listPasskeys(userId).find((p) => p.id === id);
  if (!view) throw new HttpError(500, 'INTERNAL', '凭据保存失败');
  return view;
}

// ---------- 认证（二次因子 / 无密码主登录） ----------

/** userId 为 null = 无密码主登录（discoverable，allowCredentials 为空） */
export async function passkeyAuthOptions(
  req: Request,
  userId: number | null,
): Promise<{ requestId: string; options: unknown }> {
  const { rpID } = rpInfo(req);
  const allow = userId ? listPasskeys(userId).map((c) => ({ id: c.id })) : [];
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: allow,
    userVerification: 'preferred',
  });
  const requestId = randomBytes(8).toString('hex');
  putChallenge(`auth:${requestId}`, {
    challenge: options.challenge,
    userId,
    purpose: 'auth',
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
  return { requestId, options };
}

/** 校验认证断言；返回命中的 userId（passwordless 从 userHandle 还原） */
export async function passkeyAuthVerify(
  req: Request,
  requestId: string,
  response: AuthenticationResponseJSON,
): Promise<{ userId: number; credentialId: string }> {
  const { rpID, origin } = rpInfo(req);
  const entry = takeChallenge(`auth:${String(requestId ?? '')}`);
  if (!entry) throw new HttpError(400, 'WEBAUTHN_CHALLENGE', '认证会话已过期，请重新发起');

  let userId = entry.userId;
  if (!userId) {
    const userHandle = response.response?.userHandle as string | undefined;
    if (!userHandle) throw new HttpError(400, 'WEBAUTHN_USER_HANDLE', '无法识别用户');
    userId = Number(new TextDecoder().decode(Buffer.from(userHandle, 'base64url')));
    if (!Number.isInteger(userId) || userId <= 0) throw new HttpError(400, 'WEBAUTHN_USER_HANDLE', '用户标识非法');
  }

  const cred = getDb().select().from(passkeys).where(eq(passkeys.userId, userId)).all();
  const credentialId = response.id;
  const target = cred.find((c) => c.id === credentialId) ?? cred[0];
  if (!target) throw new HttpError(400, 'PASSKEY_NOT_FOUND', '未找到对应凭据');

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: entry.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
    credential: {
      id: target.id,
      publicKey: new Uint8Array(Buffer.from(target.publicKey, 'base64url')),
      counter: target.counter,
      transports: target.transports ? (JSON.parse(target.transports) as string[]) : undefined,
    },
  });
  if (!verification.verified) throw new HttpError(400, 'WEBAUTHN_VERIFY_FAILED', 'Passkey 校验失败');

  getDb()
    .update(passkeys)
    .set({
      counter: verification.authenticationInfo.newCounter ?? target.counter + 1,
      lastUsedAt: Date.now(),
    })
    .where(eq(passkeys.id, target.id))
    .run();
  audit(`user:${userId}`, req.clientIp ?? null, 'mfa.passkey.verify', { id: target.id });
  return { userId, credentialId: target.id };
}

/** 删除 passkey；admin 且无 TOTP 时禁止删最后一个（admin 强制 MFA） */
export function deletePasskey(userId: number, credentialId: string, isAdmin: boolean, totpBound: boolean): void {
  const row = getDb().select().from(passkeys).where(eq(passkeys.id, credentialId)).get();
  if (!row || row.userId !== userId) throw new HttpError(404, 'PASSKEY_NOT_FOUND', '凭据不存在');
  const count =
    getDb()
      .select({ n: sql<number>`count(*)` })
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .get()?.n ?? 0;
  if (isAdmin && !totpBound && count <= 1) {
    throw new HttpError(403, 'MFA_REQUIRED_FOR_ADMIN', '管理员必须保留至少一种多因子');
  }
  getDb().delete(passkeys).where(eq(passkeys.id, credentialId)).run();
  if (count - 1 === 0 && !totpBound) {
    getDb().update(users).set({ mfaEnabled: false }).where(eq(users.id, userId)).run();
  }
  audit(`user:${userId}`, null, 'mfa.passkey.deleted', { id: credentialId });
}
