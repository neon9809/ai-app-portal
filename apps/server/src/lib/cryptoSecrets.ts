/**
 * 服务端 secrets 落盘加密：data/master.key（32B，0600，首次使用时生成）
 * + AES-256-GCM。用于 TOTP 密钥、应用 upstream urlSecret（W5）等
 * 不宜明文进 SQLite 的敏感值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config/index.js';

let masterKey: Buffer | null = null;

function key(): Buffer {
  if (!masterKey) {
    const file = path.join(config.dataDir, 'master.key');
    try {
      masterKey = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
      if (masterKey.length !== 32) throw new Error('bad length');
    } catch {
      masterKey = randomBytes(32);
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file, masterKey.toString('hex') + '\n', { mode: 0o600 });
      console.log(`[crypto] 生成主密钥: ${file}`);
    }
  }
  return masterKey;
}

/** 加密字符串 → 'v1:<iv hex>:<tag hex>:<cipher hex>' */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

/** 解密；格式不符或校验失败抛错 */
export function decryptSecret(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('未知密文格式');
  const iv = Buffer.from(parts[1]!, 'hex');
  const tag = Buffer.from(parts[2]!, 'hex');
  const data = Buffer.from(parts[3]!, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
