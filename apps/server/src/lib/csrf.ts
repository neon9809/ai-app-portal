/**
 * CSRF Origin 校验——移植自参考实现 server.js：
 * 仅拦 /api 上的写方法；Origin 与 Host 精确相等（不做后缀匹配，防兄弟域）；
 * 缺 Origin/Host 放行（非浏览器客户端）；与 cookie sameSite=lax 叠加防御。
 * 注意：应用网关代理流量（/app/...）不经过此中间件（只挂 /api）。
 */
import type { RequestHandler } from 'express';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const csrfOriginCheck: RequestHandler = (req, res, next) => {
  if (!WRITE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return next(); // 非浏览器客户端
  try {
    if (new URL(origin).host === host) return next();
  } catch {
    // 非法 Origin 头 → 落到 403
  }
  res.status(403).json({
    error: { code: 'CSRF_ORIGIN_MISMATCH', message: '已阻止跨站请求（Origin 与站点不符）' },
  });
};
