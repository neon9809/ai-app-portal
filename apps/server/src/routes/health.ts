import { Router } from 'express';
import { AAP_VERSION } from '@aap/shared';
import { getSqlite } from '../db/index.js';

/**
 * 存活与健康探针（Docker HEALTHCHECK / FPK 健康检查 / 管理端仪表卡数据源）。
 * 故意不含敏感信息。
 */
export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  let dbOk = true;
  try {
    getSqlite().prepare('SELECT 1').get();
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    version: AAP_VERSION,
    uptimeSec: Math.round(process.uptime()),
  });
});
