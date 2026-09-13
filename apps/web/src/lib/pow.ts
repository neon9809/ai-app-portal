/** 客户端 PoW（hashcash）求解器：与服务端 lib/pow.ts 语义对齐 */
import { api } from '../api/client';

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

/** 求 nonce 使 SHA-256(seed:nonce) 前 difficulty 位为 0（浏览器 WebCrypto） */
export async function solvePow(ch: PowChallenge): Promise<string> {
  const enc = new TextEncoder();
  let nonce = 0;
  for (;;) {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${ch.seed}:${nonce}`));
    if (leadingZeroBits(new Uint8Array(digest)) >= ch.difficulty) return String(nonce);
    nonce++;
    if (nonce % 256 === 0) await new Promise((r) => setTimeout(r, 0)); // 让出主线程
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
