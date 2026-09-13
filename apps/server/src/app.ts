/**
 * Express 应用装配（与监听分离，便于测试）。
 * 中间件顺序约定（移植自参考实现并保留其理由）：
 *  - 代理流量（/app/...）绝不走 express.json——请求体被消费后流式转发拿到空 body，
 *    SSE/WS/POST 全挂（W5 挂代理路由时沿用此约束）。
 *  - CSRF Origin 校验只挂 /api 的写方法（W2）。
 */
import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { type AapConfig, config } from './config/index.js';
import './types.js';
import { applySecurityHeaders } from './lib/securityHeaders.js';
import { getClientIp } from './lib/security.js';
import { sessionMiddleware } from './lib/session.js';
import { csrfOriginCheck } from './lib/csrf.js';
import { healthRouter } from './routes/health.js';
import { portalRouter } from './routes/portal.js';
import { authRouter } from './routes/auth.js';
import { mfaRouter } from './routes/mfa.js';
import { appsRouter } from './routes/apps.js';
import { adminAppsRouter } from './routes/adminApps.js';
import { adminTlsRouter } from './routes/adminTls.js';
import { userRouter } from './routes/user.js';
import { adminRouter } from './routes/admin.js';
import { guideRouter } from './routes/guide.js';
import { portalChromeJs } from './gateway/staticApp.js';
import { appsRunRouter } from './routes/appsRun.js';
import { aapRouter } from './routes/aap.js';
import { llmGatewayRouter } from './routes/llmGateway.js';
import { adminLlmRouter } from './routes/adminLlm.js';
import { adminBillingRouter } from './routes/adminBilling.js';
import { gatewayRouter } from './gateway/proxy.js';
import { acmeChallengeResponse } from './gateway/tls.js';
import { getSettingBool } from './lib/settings.js';
import { HttpError, toBody } from './lib/httpError.js';


export function createApp(cfg: AapConfig = config): Express {
  const app = express();
  app.disable('x-powered-by');
  // TRUST_PROXY 语义（参考实现）：无前置代理置 false，防伪造 XFF 绕过封禁；
  // 有前置代理置 1，只信第一跳。
  app.set('trust proxy', cfg.trustProxy ? 1 : false);

  applySecurityHeaders(app);
  app.use(cookieParser());

  // 真实客户端 IP（封禁/PoW/审计/限流全部依赖）
  app.use((req, _res, next) => {
    req.clientIp = getClientIp(req);
    next();
  });

  // 会话装载（cookie → sessions 表 → req.user）
  app.use(sessionMiddleware);

  // /api 下的 JSON body 与 CSRF Origin 校验；/app 代理路径不经过这里（W5 起独立挂载）
  // .neon-aap 包上传需要更大的 JSON 体积（仅此路径）
  app.use('/api/admin/apps/package', express.json({ limit: '15mb' }));
  app.use('/api/apps/submit', express.json({ limit: '15mb' }));

  app.use('/api', csrfOriginCheck);
  app.use('/api', express.json({ limit: '1mb' }));

  // ACME HTTP-01 挑战应答（80/HTTP 端口直达本服务或反代转发均可）
  app.get('/.well-known/acme-challenge/:token', (req, res) => {
    const ka = acmeChallengeResponse(String(req.params.token));
    if (ka) {
      res.type('text/plain').send(ka);
      return;
    }
    res.status(404).end();
  });

  // HTTP → HTTPS 跳转开关（B3；默认关，ACME 挑战已在上方处理）
  app.use((req, res, next) => {
    if (getSettingBool('HTTPS_REDIRECT', false) && !req.path.startsWith('/.well-known/acme-challenge/')) {
      const proto = req.protocol;
      if (proto === 'http') {
        const host = (req.headers.host ?? '').replace(/:\d+$/, '');
        const port = config.httpsPort;
        res.redirect(301, `https://${host}${port === 443 ? '' : ':' + port}${req.originalUrl}`);
        return;
      }
    }
    next();
  });

  app.use('/api', healthRouter);
  app.use('/api', portalRouter);
  app.use('/api', authRouter);
  app.use('/api', mfaRouter);
  app.use('/api', appsRouter);
  app.use('/api', adminAppsRouter);
  app.use('/api', adminTlsRouter);
  app.use('/api', userRouter);
  app.use('/api', adminRouter);
  app.use('/api', guideRouter);
  app.use('/api', adminLlmRouter);
  app.use('/api', adminBillingRouter);
  app.use('/api', appsRunRouter);
  app.use('/api/aap', aapRouter);

  // 应用网关（B1）：/app/<id>/ 路径反代。必须在 SPA 兜底之前挂载；
  // 不经过 express.json（流式 body 保真），CSRF 不适用（仅 /api 挂载）。
  // 统一页面元素脚本（P3）：被注入到所有门户代理/托管的 HTML 应用
  app.get('/portal-chrome.js', (_req, res) => {
    res.type('text/javascript; charset=utf-8').send(portalChromeJs());
  });

  // LLM 网关（M2，C1）：/v1/* OpenAI 兼容端点，独立于 /api（SDK 直连，无 cookie/CSRF）
  app.use('/v1', express.json({ limit: '2mb' }));
  app.use(llmGatewayRouter);

  app.use(gatewayRouter);

  // 未知 API 一律 JSON 404（避免 SPA 兜底吞掉打错的接口）
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
  });

  // 生产托管前端构建产物 + SPA 兜底（目录不存在则跳过——开发时由 Vite 提供）
  const webIndex = cfg.webDist ? path.join(cfg.webDist, 'index.html') : null;
  if (cfg.webDist && webIndex && fs.existsSync(webIndex)) {
    app.use(express.static(cfg.webDist, { index: false }));
    app.get('*', (_req, res) => {
      res.sendFile(webIndex);
    });
  }

  // 全局错误处理：JSON 错误契约 { error: { code, message } }；不向客户端泄漏堆栈
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (typeof err === 'object' && err !== null && 'type' in err && (err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } });
      return;
    }
    if (err instanceof HttpError) {
      const { status, body } = toBody(err);
      res.status(status).json(body);
      return;
    }
    console.error('[server] unhandled error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
    } else {
      res.end();
    }
  });

  return app;
}
