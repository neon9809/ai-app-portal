/**
 * 身份注入（passUser）——移植自参考实现 webuiIdentity.js，剥离单位指纹：
 *   X-AAP-Identity: base64url(JSON payload)
 *   X-AAP-Identity-Sig: hex(HMAC-SHA256(secret, payload))
 * payload 含 aud（目标应用 id，防身份头转发重放）、jti（一次性）、
 * iat/exp（10 分钟 TTL）、kind+uid（消费端必须按 (kind, uid) 或 subject
 * 隔离账号数据——uid 单调即全局唯一，契约保留 kind 以兼容外部实现）。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { IDENTITY_HEADER, IDENTITY_SIG_HEADER, IDENTITY_TTL_MS } from '@aap/shared';
import type { SessionUser } from '../types.js';
import { getSetting } from '../lib/settings.js';

export interface SignedIdentity {
  payload: string;
  sig: string;
}

export function signIdentity(user: SessionUser, appId: string): SignedIdentity | null {
  const secret = getSetting('AAP_SIGN_SECRET');
  if (!secret || !user?.id) return null;
  const payload = {
    uid: String(user.id),
    subject: user.subject,
    name: user.name,
    email: user.email,
    kind: user.kind,
    aud: appId,
    iat: Date.now(),
    exp: Date.now() + IDENTITY_TTL_MS,
    jti: randomBytes(8).toString('hex'),
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(b64).digest('hex');
  return { payload: b64, sig };
}

/** 应用侧验签（供自研应用后端参考实现；平台测试用）。
 *  exp 强制存在且未过期；jti 一次性（TTL 窗口内防重放，P3-16）——
 *  平台内部归因（/api/aap/llm/chat 读沙箱环境变量身份）传 allowReplay 豁免，
 *  因为同一次 invoked 运行会多次携带同一身份。 */
const seenJti = new Map<string, number>(); // jti → exp

function jtiNotReplayed(jti: string, exp: number): boolean {
  const now = Date.now();
  if (seenJti.size > 10_000) {
    for (const [k, e] of seenJti) if (e < now) seenJti.delete(k);
  }
  if (seenJti.has(jti)) return false;
  seenJti.set(jti, exp);
  return true;
}

export function verifyIdentity(
  payloadB64: string,
  sigHex: string,
  secret: string,
  expectAud: string,
  opts?: { allowReplay?: boolean },
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const expect = createHmac('sha256', secret).update(payloadB64).digest('hex');
  const a = Buffer.from(sigHex, 'hex');
  const b = Buffer.from(expect, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: 'BAD_SIGNATURE' };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'BAD_PAYLOAD' };
  }
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return { ok: false, error: 'EXPIRED' };
  if (payload.aud !== expectAud) return { ok: false, error: 'AUD_MISMATCH' };
  if (typeof payload.jti !== 'string' || !payload.jti) return { ok: false, error: 'BAD_JTI' };
  if (!opts?.allowReplay && !jtiNotReplayed(payload.jti, payload.exp)) return { ok: false, error: 'JTI_REPLAYED' };
  return { ok: true, payload };
}

export { IDENTITY_HEADER, IDENTITY_SIG_HEADER };
