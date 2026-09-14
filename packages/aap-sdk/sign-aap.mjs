#!/usr/bin/env node
/**
 * .neon-aap 包签名工具（Ed25519 信任链，设计参照 fnos-dashboard 的 ndash.py）。
 *
 *   node sign-aap.mjs keygen -o mykey.secret            # 生成密钥对（私钥 0600）
 *   node sign-aap.mjs sign pkg.neon-aap --key mykey.secret --signer your-name
 *   node sign-aap.mjs verify pkg.neon-aap               # 发行前自检（不查信任列表）
 *
 * 签名格式（包内 signature.json，可选文件）：
 *   { alg: "ed25519", payload_sha256, signature(b64), signer: { id, key_id, public_key(b64) } }
 * 规范化摘要：对除 signature.json 外的全部条目，按「文件名 UTF-8 字节序」排序，
 * sha256( name_utf8 + 0x00 + sha256(content) ) 逐项拼接后再 sha256 → hex。
 * 与 zip 时间戳/压缩参数/条目物理顺序无关：内容一致则摘要一致。
 *
 * 平台侧验证：签名不符（篡改）→ 拒绝上传；签名者 key_id 在平台信任列表 →
 * verified（官方签名免审）；否则 untrusted（照常走审核）。算法用 Node 内置
 * crypto（OpenSSL，RFC 8032 Ed25519），密钥为 32 字节原始种子/公钥的 base64。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SIG_NAME = 'signature.json';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const b64e = (b) => Buffer.from(b).toString('base64');
const b64d = (s) => Buffer.from(String(s), 'base64');

function publicKeyFromRaw(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function privateKeyFromRaw(seed) {
  return crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

export function keyId(publicRaw) {
  return 'SHA256:' + crypto.createHash('sha256').update(publicRaw).digest('hex').slice(0, 16);
}

export function keypair(seed = crypto.randomBytes(32)) {
  if (seed.length !== 32) throw new Error('私钥种子必须是 32 字节');
  const pub = crypto.createPublicKey(privateKeyFromRaw(seed)).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { secret: seed, public: pub };
}

/** 规范化摘要：entries = [{ name, content: Buffer }]（不含 signature.json） */
export function payloadDigest(entries) {
  const hash = crypto.createHash('sha256');
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')));
  for (const e of sorted) {
    hash.update(Buffer.from(e.name, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(crypto.createHash('sha256').update(e.content).digest());
  }
  return hash.digest('hex');
}

export function signPackage(entries, secretRaw, signerId = '') {
  const { public: pub } = keypair(secretRaw);
  const digest = payloadDigest(entries);
  const signature = crypto.sign(null, Buffer.from(digest, 'hex'), privateKeyFromRaw(secretRaw));
  return {
    alg: 'ed25519',
    payload_sha256: digest,
    signature: b64e(signature),
    signer: { id: signerId, key_id: keyId(pub), public_key: b64e(pub) },
  };
}

/** 用包内自带的公钥验签（完整性）；信任与否由调用方按 key_id 判断 */
export function verifyPackageSignature(entries, sigObj) {
  if (!sigObj || sigObj.alg !== 'ed25519' || !sigObj.signature || !sigObj.signer?.public_key) {
    return { ok: false, reason: 'signature.json 缺失或字段不完整' };
  }
  let pub, sig;
  try {
    pub = b64d(sigObj.signer.public_key);
    sig = b64d(sigObj.signature);
  } catch {
    return { ok: false, reason: '签名/公钥不是合法 base64' };
  }
  if (pub.length !== 32 || sig.length !== 64) return { ok: false, reason: '公钥/签名长度不符' };
  if (keyId(pub) !== sigObj.signer.key_id) return { ok: false, reason: 'key_id 与公钥不符' };
  const digest = payloadDigest(entries);
  if (digest !== sigObj.payload_sha256) return { ok: false, reason: '包内容与摘要不符（文件被增删改）' };
  const ok = crypto.verify(null, Buffer.from(digest, 'hex'), publicKeyFromRaw(pub), sig);
  return ok ? { ok: true, keyId: sigObj.signer.key_id } : { ok: false, reason: '签名验证失败' };
}

// ---------- zip 读写（复用服务器同款 adm-zip，devDependency） ----------

async function loadZipEntries(file, { skipSignature = false } = {}) {
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip(fs.readFileSync(file));
  const entries = [];
  let signature = null;
  for (const e of zip.getEntries()) {
    if (e.isError) continue;
    const name = e.entryName.replace(/\\/g, '/');
    if (name.endsWith('/')) continue;
    const content = e.getData();
    if (name === SIG_NAME) {
      signature = JSON.parse(content.toString('utf8'));
      continue;
    }
    if (!skipSignature) entries.push({ name, content });
  }
  return { entries, signature };
}

async function writeSignedZip(file) {
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip(fs.readFileSync(file));
  const existing = zip.getEntry(SIG_NAME);
  if (existing) zip.deleteFile(existing);
  return zip;
}

async function cmdKeygen(argv) {
  const out = argv[0] && argv[0] !== '-o' ? argv[0] : argv.includes('-o') ? argv[argv.indexOf('-o') + 1] : 'aap-sign.secret';
  const { secret, public: pub } = keypair();
  fs.writeFileSync(out, b64e(secret) + '\n', { mode: 0o600 });
  fs.writeFileSync(out.replace(/\.(secret)$/, '.pub'), b64e(pub) + '\n');
  console.log(`私钥: ${out}（0600，妥善保管，勿提交仓库）`);
  console.log(`公钥: ${out.replace(/\.(secret)$/, '.pub')}`);
  console.log(`key_id: ${keyId(pub)}   public_key(b64): ${b64e(pub)}`);
}

async function cmdSign(argv) {
  const file = argv[0];
  const keyIdx = argv.indexOf('--key');
  const keyFile = keyIdx >= 0 ? argv[keyIdx + 1] : null;
  const signerIdx = argv.indexOf('--signer');
  const signerId = signerIdx >= 0 ? argv[signerIdx + 1] ?? '' : '';
  if (!file || !keyFile) {
    console.error('用法: sign-aap.mjs sign <pkg.neon-aap> --key <secret 文件> [--signer 署名]');
    process.exit(1);
  }
  const secret = b64d(fs.readFileSync(keyFile, 'utf8').trim());
  const { entries } = await loadZipEntries(file);
  const sig = signPackage(entries, secret, signerId);
  const zip = await writeSignedZip(file);
  zip.addFile(SIG_NAME, Buffer.from(JSON.stringify(sig, null, 2)));
  zip.writeZip(file);
  console.log(`已签名: ${file}`);
  console.log(`key_id: ${sig.signer.key_id}   payload_sha256: ${sig.payload_sha256}`);
  console.log('提示：平台管理员需把该 public_key 加入信任列表，方可获得 verified（官方签名免审）。');
}

async function cmdVerify(argv) {
  const file = argv[0];
  if (!file) {
    console.error('用法: sign-aap.mjs verify <pkg.neon-aap>');
    process.exit(1);
  }
  const { entries, signature } = await loadZipEntries(file);
  if (!signature) {
    console.log('unsigned（未签名）');
    return;
  }
  const r = verifyPackageSignature(entries, signature);
  if (r.ok) {
    console.log(`verified（签名有效）  key_id=${r.keyId}`);
    console.log('注：是否「可信」由平台信任列表判定，本命令只验证完整性。');
  } else {
    console.error(`invalid（签名无效）: ${r.reason}`);
    process.exit(1);
  }
}

const [, , cmd, ...argv] = process.argv;
const commands = { keygen: cmdKeygen, sign: cmdSign, verify: cmdVerify };
if (!cmd || !commands[cmd]) {
  console.error('用法: sign-aap.mjs <keygen|sign|verify> ...（详见文件头注释）');
  process.exit(1);
}
await commands[cmd](argv);
