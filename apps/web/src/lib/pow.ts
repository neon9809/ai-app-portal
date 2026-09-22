/** 客户端 PoW（hashcash）求解器：与服务端 lib/pow.ts 语义对齐 */
import { api } from '../api/client';
import { sha256Sync } from './sha256';

export interface PowChallenge {
  challengeId: string;
  seed: string;
  difficulty: number;
}

function leadingZeroBits(buf: Uint8Array): number {
  let bits = 0;
  for (const b of buf) {
    if (b === 0) {
      bits += 8;
      continue;
    }
    for (let i = 7; i >= 0; i--) {
      if ((b >> i) & 1) return bits;
      bits++;
    }
    break;
  }
  return bits;
}

/**
 * 求 nonce 使 SHA-256(seed:nonce) 前 difficulty 位为 0。
 * 优先 WebCrypto；非安全上下文（HTTP 部署，crypto.subtle 不存在，注册/登录 PoW/
 * 绑定邮箱发码等均会触发）回退到纯 JS SHA-256。
 */
export async function solvePow(ch: PowChallenge): Promise<string> {
  const enc = new TextEncoder();
  const subtle = globalThis.crypto?.subtle;
  let nonce = 0;
  if (subtle) {
    for (;;) {
      const digest = await subtle.digest('SHA-256', enc.encode(`${ch.seed}:${nonce}`));
      if (leadingZeroBits(new Uint8Array(digest)) >= ch.difficulty) return String(nonce);
      nonce++;
      if (nonce % 256 === 0) await new Promise((r) => setTimeout(r, 0)); // 让出主线程
    }
  }
  for (;;) {
    if (leadingZeroBits(sha256Sync(enc.encode(`${ch.seed}:${nonce}`))) >= ch.difficulty) return String(nonce);
    nonce++;
    if (nonce % 4096 === 0) await new Promise((r) => setTimeout(r, 0)); // 让出主线程
  }
}

/** 完整流程：拿挑战 → 解题 → 换一次性 token（注册/找回等写入口用） */
export async function obtainPowToken(): Promise<string> {
  const { challenge } = await api<{ challenge: PowChallenge }>('/api/auth/pow', { method: 'POST' });
  const nonce = await solvePow(challenge);
  const { token } = await api<{ token: string }>('/api/auth/pow/verify', {
    method: 'POST',
    json: { challengeId: challenge.challengeId, nonce },
  });
  return token;
}
