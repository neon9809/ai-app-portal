/**
 * Cloudflare Turnstile 人机验证（A2 可选项）：后台填 key 即启用，默认关闭，
 * PoW 为兜底（内网可离线）。
 */
import { getSetting } from './settings.js';

export function turnstileEnabled(): boolean {
  return Boolean(getSetting('TURNSTILE_SECRET_KEY') && getSetting('TURNSTILE_SITE_KEY'));
}

export async function verifyTurnstile(token: string | undefined | null, ip: string): Promise<boolean> {
  if (!turnstileEnabled()) return true; // 未启用 → 放行（PoW 兜底）
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: getSetting('TURNSTILE_SECRET_KEY') ?? '',
        response: token,
        remoteip: ip,
      }),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error('[turnstile] 校验失败:', err);
    return false;
  }
}
