/**
 * 管理端证书 API（B3/E1）：手动 PEM 上传热替换、ACME 签发触发、状态查询。
 * 供管理后台状态仪表卡与证书面板使用（W9 完成可视化）。
 */
import { Router } from 'express';
import { HttpError, h } from '../lib/httpError.js';
import { requireAdmin } from '../lib/auth.js';
import * as tls from '../gateway/tls.js';
import { setSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';

export const adminTlsRouter = Router();

adminTlsRouter.use('/admin/tls', requireAdmin);

adminTlsRouter.get(
  '/admin/tls',
  h(async (_req, res) => {
    res.json(tls.status());
  }),
);

adminTlsRouter.put(
  '/admin/tls',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { cert?: string; key?: string };
    if (!body.cert?.trim() || !body.key?.trim()) {
      throw new HttpError(400, 'INVALID_INPUT', '请同时提供证书（cert）与私钥（key）的 PEM 内容');
    }
    try {
      const info = tls.installManual(body.cert, body.key);
      res.json({ ok: true, cert: info });
    } catch (err) {
      throw new HttpError(400, 'INVALID_CERT', err instanceof Error ? err.message : '证书校验失败');
    }
  }),
);

adminTlsRouter.delete(
  '/admin/tls',
  h(async (req, res) => {
    tls.remove();
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'tls.cert.removed', { by: 'admin' });
    res.json({ ok: true });
  }),
);

adminTlsRouter.post(
  '/admin/tls/acme',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { domain?: string; email?: string; staging?: boolean };
    const domain = String(body.domain ?? '').trim().toLowerCase();
    const email = String(body.email ?? '').trim();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      throw new HttpError(400, 'INVALID_DOMAIN', '域名格式不正确');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpError(400, 'INVALID_EMAIL', '邮箱格式不正确');
    }
    setSetting('ACME_DOMAIN', domain);
    setSetting('ACME_EMAIL', email);
    if (body.staging !== undefined) setSetting('ACME_STAGING', body.staging ? 'true' : 'false');
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'tls.acme.start', { domain, staging: body.staging });

    // 异步签发（数十秒）：立即返回，管理端轮询状态
    void tls
      .acmeIssue(domain, email)
      .catch((err) => console.error('[tls] ACME 后台签发失败:', err instanceof Error ? err.message : err));
    res.json({ ok: true, started: true });
  }),
);
