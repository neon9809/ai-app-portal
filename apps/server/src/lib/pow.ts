/**
 * 工作量证明（hashcash 风格，SHA-256 前导零位）——移植自参考实现 lib/pow.js。
 * 挑战：给定 seed 与 difficulty（前导零位数），客户端求 nonce 使
 * SHA-256(seed + ':' + nonce) 二进制前 difficulty 位为 0。
 * 服务端校验读后即删（一次性）、绑 IP、短时效。
 */
import { createHash, randomBytes } from 'node:crypto';
import { getSqlite } from '../db/index.js';
import { getSettingInt } from './settings.js';
import { issuePowToken, powDifficulty } from './security.js';

interface ChallengeRow {
  id: string;
  seed: string;
  difficulty: number;
  ip: string;
  created_at: number;
  expires_at: number;
}

export interface PowChallenge {
  challengeId: string;
  seed: string;
  difficulty: number;
}

export function issueChallenge(ip: string): PowChallenge {
  const challengeId = randomBytes(16).toString('hex');
  const seed = randomBytes(16).toString('hex');
  const difficulty = powDifficulty(ip);
  const now = Date.now();
  const ttl = getSettingInt('POW_CHALLENGE_TTL', 300);
  getSqlite()
    .prepare('INSERT INTO pow_challenges(id, seed, difficulty, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(challengeId, seed, difficulty, ip, now, now + ttl * 1000);
  return { challengeId, seed, difficulty };
}

export type PowVerifyResult = { ok: true; token: string } | { ok: false; error: string };

/** 服务端校验：返回 PoW token（绑 IP）；挑战读后即删防重放 */
export function verifyPow(challengeId: string, nonce: string, ip: string): PowVerifyResult {
  const s = getSqlite();
  const ch = s.prepare('SELECT * FROM pow_challenges WHERE id = ?').get(challengeId) as ChallengeRow | undefined;
  if (!ch) return { ok: false, error: 'CHALLENGE_NOT_FOUND' };
  s.prepare('DELETE FROM pow_challenges WHERE id = ?').run(challengeId);
  if (ch.expires_at <= Date.now()) return { ok: false, error: 'CHALLENGE_EXPIRED' };
  if (ch.ip !== ip) return { ok: false, error: 'IP_MISMATCH' };

  // nonce 必须是纯数字（客户端 WebCrypto 循环产物）
  if (!/^[0-9]+$/.test(String(nonce))) return { ok: false, error: 'INVALID_NONCE' };

  const hashHex = createHash('sha256').update(`${ch.seed}:${nonce}`).digest('hex');
  if (!hasLeadingZeroBits(hashHex, ch.difficulty)) {
    return { ok: false, error: 'PROOF_INVALID' };
  }
  return { ok: true, token: issuePowToken(ip) };
}

/** 判断十六进制哈希的前 N 个二进制位是否全为 0（按 nibble 逐位判断） */
export function hasLeadingZeroBits(hashHex: string, bits: number): boolean {
  let remaining = bits;
  for (let i = 0; i < hashHex.length && remaining > 0; i++) {
    const nibble = parseInt(hashHex[i]!, 16);
    if (nibble === 0) {
      remaining -= 4;
      continue;
    }
    let z = 0;
    for (let b = 3; b >= 0; b--) {
      if ((nibble >> b) & 1) break;
      z++;
    }
    return z >= remaining;
  }
  return remaining <= 0;
}
