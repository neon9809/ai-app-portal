import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { getSqlite } from '../db/index.js';
import {
  accountFailuresInWindow,
  clearMfaFailures,
  consumePowToken,
  failuresInWindow,
  isBanned,
  mfaFailuresInWindow,
  needsPow,
  powDifficulty,
  recordFailure,
  recordMfaFailure,
  recordSuccess,
} from '../lib/security.js';
import { hasLeadingZeroBits, issueChallenge, verifyPow } from '../lib/pow.js';

let dir: string;
const IP = '203.0.113.10';

beforeAll(() => {
  ({ dir } = setupTestDb());
});
afterAll(() => teardownTestDb(dir));

describe('security（失败计数 + IP 封禁累犯倍增）', () => {
  it('初始无失败、不封禁、不需要 PoW', () => {
    expect(failuresInWindow(IP)).toBe(0);
    expect(isBanned(IP)).toBeNull();
    expect(needsPow(IP)).toBe(false);
    expect(powDifficulty(IP)).toBe(16);
  });

  it('失败达阈值后要求 PoW；超过阈值后难度按步进提升', () => {
    for (let i = 0; i < 5; i++) recordFailure(IP, 'local:alice', 'bad-password');
    expect(failuresInWindow(IP)).toBe(5);
    expect(needsPow(IP)).toBe(true);
    expect(powDifficulty(IP)).toBe(16); // 达阈值：over=0 → base
    recordFailure(IP, 'local:alice', 'bad-password'); // 6
    expect(powDifficulty(IP)).toBe(18); // over=1 → base+step
  });

  it('成功登录不计入失败窗口（窗口滑动，不因成功清零）', () => {
    recordSuccess(IP, 'local:alice');
    expect(failuresInWindow(IP)).toBe(6);
  });

  it('失败达 IP_BAN_THRESHOLD 触发自动封禁（base 时长）', () => {
    let res = { banned: false } as ReturnType<typeof recordFailure>;
    for (let i = 0; i < 10 && !res.banned; i++) {
      res = recordFailure(IP, 'local:alice', 'brute');
    }
    expect(res.banned).toBe(true);
    const ban = isBanned(IP);
    expect(ban).not.toBeNull();
    expect(ban!.repeat_count).toBe(1);
    expect(ban!.banned_until - Date.now()).toBeGreaterThan(3500_000); // base 3600s
  });

  it('累犯封禁时长翻倍（repeat_count +1 → base*2^1）', () => {
    // 人为使封禁过期（不删行，保住 repeat_count）
    getSqlite().prepare('UPDATE ip_bans SET banned_until = ? WHERE ip = ?').run(Date.now() - 1, IP);
    expect(isBanned(IP)).toBeNull();
    let res = { banned: false } as ReturnType<typeof recordFailure>;
    for (let i = 0; i < 10 && !res.banned; i++) {
      res = recordFailure(IP, 'local:alice', 'brute-again');
    }
    expect(res.banned).toBe(true);
    const ban = isBanned(IP)!;
    expect(ban.repeat_count).toBe(2);
    expect(ban.banned_until - Date.now()).toBeGreaterThan(7000_000); // 3600*2 = 7200s
  });
});

describe('pow challenge/verify（服务端全流程）', () => {
  const IP2 = '203.0.113.99';

  it('签发→解题→换 token→一次性消费', () => {
    expect(needsPow(IP2)).toBe(false); // 未失败也可主动走 PoW（注册等场景）
    const ch = issueChallenge(IP2);
    let nonce = 0;
    for (;; nonce++) {
      const h = createHash('sha256').update(`${ch.seed}:${nonce}`).digest('hex');
      if (hasLeadingZeroBits(h, ch.difficulty)) break;
    }
    const v = verifyPow(ch.challengeId, String(nonce), IP2);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(consumePowToken(v.token, IP2)).toBe(true);
    expect(consumePowToken(v.token, IP2)).toBe(false); // 一次性
  });

  it('挑战读后即删（重放拒绝）、IP 不匹配拒绝、nonce 非法拒绝', () => {
    const ch = issueChallenge(IP2);
    expect(verifyPow(ch.challengeId, '1', '6.6.6.6')).toMatchObject({ ok: false, error: 'IP_MISMATCH' });
    // 上一步已消费该挑战
    expect(verifyPow(ch.challengeId, '1', IP2)).toMatchObject({ ok: false, error: 'CHALLENGE_NOT_FOUND' });

    const ch2 = issueChallenge(IP2);
    expect(verifyPow(ch2.challengeId, 'abc', IP2)).toMatchObject({ ok: false, error: 'INVALID_NONCE' });
    expect(verifyPow(ch2.challengeId, '0', IP2).ok).toBe(false); // 解不对
    expect(verifyPow('no-such', '1', IP2)).toMatchObject({ ok: false, error: 'CHALLENGE_NOT_FOUND' });
  });
});

describe('MFA 账号维度错猜计数（终审 P1-3）', () => {
  const KEY = 'mfa:777';

  it('持久计数（login_attempts）、命名空间隔离、成功清零、不污染 IP 维度', () => {
    expect(mfaFailuresInWindow(KEY)).toBe(0);
    for (let i = 0; i < 4; i++) recordMfaFailure(KEY);
    expect(mfaFailuresInWindow(KEY)).toBe(4);
    recordMfaFailure(KEY);
    expect(mfaFailuresInWindow(KEY)).toBe(5);

    // 计数落在 login_attempts 表（重启不丢），subject 用 mfa:<userId> 命名空间
    const row = getSqlite()
      .prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE user_key = ? AND success = 0")
      .get(KEY) as { n: number };
    expect(row.n).toBe(5);
    // 命名空间隔离：不影响其他账号/其他维度
    expect(accountFailuresInWindow('mfa:778')).toBe(0);
    expect(accountFailuresInWindow('local:someone')).toBe(0);

    // 哨兵 ip='mfa-guard'：不污染真实 IP 的失败窗口与 PoW 判定
    expect(failuresInWindow('198.51.100.7')).toBe(0);
    expect(needsPow('198.51.100.7')).toBe(false);
    expect(isBanned('198.51.100.7')).toBeNull();

    // 成功验证清零（防正常用户被误锁）
    clearMfaFailures(KEY);
    expect(mfaFailuresInWindow(KEY)).toBe(0);
  });
});
