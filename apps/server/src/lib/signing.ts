/**
 * .neon-aap 包签名验证（G4，Ed25519 信任链）——设计参照 fnos-dashboard 的
 * ndash 方案：签名放包内 signature.json，摘要与 zip 时间戳/压缩参数/条目顺序
 * 无关；四态判定 verified / untrusted / unsigned / invalid（invalid 硬拒上传）。
 * 算法用 Node 内置 crypto（RFC 8032 Ed25519）；签名工具见
 * packages/aap-sdk/sign-aap.mjs（keygen/sign/verify）。
 * 信任语义：key_id 命中 trusted_signing_keys → verified（官方签名免审）。
 */
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { trustedSigningKeys } from '../db/schema.js';

export type PackageSignatureStatus = 'verified' | 'untrusted' | 'unsigned' | 'invalid';

export interface ZipEntryLike {
  name: string;
  content: Buffer;
}

export interface SignatureObj {
  alg?: unknown;
  payload_sha256?: unknown;
  signature?: unknown;
  signer?: { id?: unknown; key_id?: unknown; public_key?: unknown };
}

export interface SignatureCheck {
  status: PackageSignatureStatus;
  keyId?: string;
  signerId?: string;
  reason?: string;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** 'SHA256:' + sha256(public_key) 前 16 字节 hex（与签名工具约定一致） */
export function keyIdOf(publicRaw: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(publicRaw).digest('hex').slice(0, 16);
}

/**
 * 规范化摘要：按「条目文件名 UTF-8 字节序」排序，
 * sha256( name_utf8 + 0x00 + sha256(content) ) 逐项拼接后再 sha256 → hex。
 */
export function payloadDigest(entries: ZipEntryLike[]): string {
  const hash = crypto.createHash('sha256');
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')),
  );
  for (const e of sorted) {
    hash.update(Buffer.from(e.name, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(crypto.createHash('sha256').update(e.content).digest());
  }
  return hash.digest('hex');
}

function publicKeyFromRaw(raw: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** 包内自带公钥验完整性；信任与否由 checkPackageSignature 按信任列表判定 */
function verifyWithEmbeddedKey(
  entries: ZipEntryLike[],
  sig: SignatureObj,
): { ok: true; keyId: string } | { ok: false; reason: string } {
  if (sig.alg !== 'ed25519') return { ok: false, reason: '签名算法不是 ed25519' };
  if (typeof sig.signature !== 'string' || typeof sig.signer?.public_key !== 'string') {
    return { ok: false, reason: 'signature.json 缺少 signature/signer.public_key' };
  }
  let pub: Buffer;
  let sigBytes: Buffer;
  try {
    pub = Buffer.from(sig.signer.public_key, 'base64');
    sigBytes = Buffer.from(sig.signature, 'base64');
  } catch {
    return { ok: false, reason: '签名/公钥不是合法 base64' };
  }
  if (pub.length !== 32 || sigBytes.length !== 64) return { ok: false, reason: '公钥/签名长度不符' };
  const digest = payloadDigest(entries);
  if (digest !== sig.payload_sha256) return { ok: false, reason: '包内容与摘要不符（文件被增删改）' };
  const ok = crypto.verify(null, Buffer.from(digest, 'hex'), publicKeyFromRaw(pub), sigBytes);
  if (!ok) return { ok: false, reason: '签名验证失败' };
  const keyId = typeof sig.signer.key_id === 'string' ? sig.signer.key_id : keyIdOf(pub);
  if (keyId !== keyIdOf(pub)) return { ok: false, reason: 'key_id 与公钥不符' };
  return { ok: true, keyId };
}

/** 四态判定：invalid 必须拒绝上传；verified 由信任列表决定 */
export function checkPackageSignature(entries: ZipEntryLike[], sig: SignatureObj | null): SignatureCheck {
  if (!sig || typeof sig !== 'object') return { status: 'unsigned' };
  const r = verifyWithEmbeddedKey(entries, sig);
  if (!r.ok) return { status: 'invalid', reason: r.reason };
  const trusted = getDb()
    .select({ id: trustedSigningKeys.id, name: trustedSigningKeys.name })
    .from(trustedSigningKeys)
    .where(eq(trustedSigningKeys.keyId, r.keyId))
    .get();
  return {
    status: trusted ? 'verified' : 'untrusted',
    keyId: r.keyId,
    signerId: typeof sig.signer?.id === 'string' ? sig.signer.id : trusted?.name ?? '',
  };
}
