import { Router } from 'express';
import { getSqlite } from '../db/index.js';

/**
 * 存活与健康探针（Docker HEALTHCHECK / FPK 健康检查）。
 * 仅回 ok/存活状态：version 与 uptimeSec 是指纹/重启监控信息，
 * 已移入管理员总览 /api/admin/overview（信息泄露收敛，渗透测试 P2-12）。
 */
export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  let dbOk = true;
  try {
    getSqlite().prepare('SELECT 1').get();
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({ ok: dbOk });
});
