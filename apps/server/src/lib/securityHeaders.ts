/**
 * 安全响应头——移植自参考实现 server.js（剥离单位指纹）。
 * HSTS 由 TLS 模块在 HTTPS 实际启用时追加（W6）。
 * 注意：代理响应会剥上游的 XFO/CSP（routes/gateway），本中间件设置的
 * 是门户自身的响应头，二者不冲突（代理响应经 res 也会带上这里的头，
 * 上游的冲突头已被剥除）。
 */
import type { Express } from 'express';

const CSP = "object-src 'none'; base-uri 'self'; frame-ancestors 'self'";

// HSTS 状态由 TLS 模块在 HTTPS 实际启用/移除时调置（此前 hstsHeader 为死代码，
// 线上 HTTPS 无该头，渗透测试 P2-13）
let hstsValue: string | null = null;

export function enableHsts(includeSubdomains: boolean): void {
  hstsValue = hstsHeader(includeSubdomains);
}

export function disableHsts(): void {
  hstsValue = null;
}

export function applySecurityHeaders(app: Express): void {
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    if (hstsValue) res.setHeader('Strict-Transport-Security', hstsValue);
    next();
  });
}

/** HTTPS 启用时调用（W6），含 2 年 HSTS；子域可选 */
export function hstsHeader(includeSubdomains: boolean): string {
  return `max-age=63072000${includeSubdomains ? '; includeSubDomains' : ''}`;
}
