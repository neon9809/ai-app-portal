/**
 * 应用网关限流：双维度令牌桶（B1）——每登录用户为主（NAT 场景互不挤爆）
 * + 每 IP 兜底；匿名仅按 IP。参考实现的固定窗口在此升级为真令牌桶。
 */
import { getSettingInt } from '../lib/settings.js';

interface Bucket {
  tokens: number;
  last: number;
}

export class RateLimiter {
  private hits = new Map<string, Bucket>();

  constructor(
    private readonly perMinSettingKey: string,
    private readonly fallbackPerMin: number,
  ) {}

  private capacity(): number {
    return getSettingInt(this.perMinSettingKey, this.fallbackPerMin);
  }

  allow(key: string): boolean {
    const now = Date.now();
    const capacity = this.capacity();
    const refillPerMs = capacity / 60_000;
    let b = this.hits.get(key);
    if (!b) {
      b = { tokens: capacity, last: now };
      this.hits.set(key, b);
    }
    b.tokens = Math.min(capacity, b.tokens + (now - b.last) * refillPerMs);
    b.last = now;
    if (b.tokens < 1) {
      if (this.hits.size > 10_000) this.cleanup(now);
      return false;
    }
    b.tokens -= 1;
    return true;
  }

  private cleanup(now: number): void {
    for (const [k, b] of this.hits) {
      // 空桶且久未活动 → 清理
      if (b.tokens >= this.capacity() && now - b.last > 300_000) this.hits.delete(k);
    }
  }
}

const userLimiter = new RateLimiter('RATE_USER_PER_MIN', 1200);
const ipLimiter = new RateLimiter('RATE_IP_PER_MIN', 600);

/** 双维度判定；userKey 为 null（匿名）时仅走 IP 维度 */
export function allowRequest(userKey: string | null, ip: string): boolean {
  if (userKey && !userLimiter.allow(userKey)) return false;
  return ipLimiter.allow(ip);
}
