/**
 * 鉴权守卫。M1 RBAC 简化为 user.role（admin/user）；
 * M4 细粒度角色如需要再扩表。
 */
import type { RequestHandler } from 'express';
import { audit } from './audit.js';

/** 要求已登录且完成完整认证（authState === 'full'） */
export const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.user) {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } });
    return;
  }
  // MFA 待验证的半登录态只能访问 mfa 相关端点（那些端点不用 requireAuth）
  if (req.user.authState !== 'full') {
    res.status(403).json({ error: { code: 'MFA_REQUIRED', message: '需要完成多因子认证', action: 'mfa' } });
    return;
  }
  next();
};

/** 要求管理员 */
export const requireAdmin: RequestHandler = (req, res, next) => {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      audit(req.user ? `${req.user.kind}:${req.user.id}` : 'anonymous', req.clientIp ?? null, 'admin.denied', {
        path: req.path,
      });
      res.status(403).json({ error: { code: 'FORBIDDEN', message: '需要管理员权限' } });
      return;
    }
    next();
  });
};
