import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { dummyVerify, generatePassword, hashPassword, verifyPassword } from '../lib/passwords.js';
import { hasLeadingZeroBits } from '../lib/pow.js';

describe('passwords（scrypt 内核）', () => {
  it('hash→verify 往返；错误口令拒绝', async () => {
    const stored = await hashPassword('S3cret-口令');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('S3cret-口令', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('存储格式非法时走哑计算并拒绝（防时序枚举）', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await dummyVerify('x')).toBe(false);
  });

  it('generatePassword 无易混淆字符', () => {
    for (let i = 0; i < 20; i++) {
      const p = generatePassword(12);
      expect(p).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{12}$/);
    }
  });
});

describe('pow（hashcash 前导零）', () => {
  it('hasLeadingZeroBits 按 nibble 精确判定', () => {
    expect(hasLeadingZeroBits('0000ffff', 16)).toBe(true);
    expect(hasLeadingZeroBits('0000ffff', 17)).toBe(false);
    expect(hasLeadingZeroBits('00f0', 8)).toBe(true); // 0000 0000 1111 0000 → 前 8 位为 0
    expect(hasLeadingZeroBits('00f0', 9)).toBe(false);
    expect(hasLeadingZeroBits('ff', 0)).toBe(true);
  });

  it('难度 16 的解能通过 hasLeadingZeroBits', () => {
    const seed = 'cafebabe';
    let nonce = 0;
    for (;; nonce++) {
      const h = createHash('sha256').update(`${seed}:${nonce}`).digest('hex');
      if (hasLeadingZeroBits(h, 16)) break;
    }
    const h = createHash('sha256').update(`${seed}:${nonce}`).digest('hex');
    expect(hasLeadingZeroBits(h, 16)).toBe(true);
    expect(hasLeadingZeroBits(h, 20)).toBe(false);
  });
});
