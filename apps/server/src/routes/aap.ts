/**
 * .neon-aap 沙箱平台侧（M4，G2/G5）：
 *  - POST /api/aap/llm/chat   沙箱内 aap.llm.chat 的平台代理：转发网关并签名归因到运行用户
 *  - POST /api/aap/egress     沙箱内 aap.http.fetch 的唯一出口：manifest 域名白名单逐请求核验
 * 认证：X-AAP-Token（应用网关凭据，运行时由平台注入沙箱环境）。
 * 白名单执行点在平台代理侧，沙箱进程无法绕过（防 DNS rebinding/直连 IP）。
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import net from 'node:net';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { apps, users } from '../db/schema.js';
import { HttpError, h } from '../lib/httpError.js';
import { resolveAppToken, type AppTokenRow } from '../lib/llm.js';
import { signIdentity, verifyIdentity } from '../gateway/identity.js';
import { config } from '../config/index.js';
import { getSetting } from '../lib/settings.js';

export const aapRouter = Router();

function auth(req: Request): AppTokenRow {
  const bearer = (req.headers['x-aap-token'] as string | undefined) ?? '';
  const token = resolveAppToken(bearer);
  if (!token) throw new HttpError(401, 'AAP_AUTH', '沙箱凭据无效');
  return token;
}

aapRouter.use((req: Request, res: Response, next: NextFunction): void => {
  try {
    req.aapToken = auth(req);
    next();
  } catch (err) {
    const e = err as HttpError;
    res.status(e.status ?? 401).json({ error: { code: e.code ?? 'AAP_AUTH', message: e.message } });
  }
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      aapToken?: AppTokenRow;
    }
  }
}

// ---------- aap.llm.chat 平台代理（签名归因 → 网关） ----------

aapRouter.post(
  '/llm/chat',
  h(async (req: Request, res: Response) => {
    const token = req.aapToken!;
    const body = (req.body ?? {}) as {
      messages?: unknown;
      model?: string;
      max_tokens?: number;
      temperature?: number;
      identityPayload?: string;
      identitySig?: string;
    };
    if (!Array.isArray(body.messages)) {
      throw new HttpError(400, 'INVALID_INPUT', 'messages 必填');
    }
    // 能力声明校验（G1）：未声明 llm 的包不允许调用
    const app = getDb().select().from(apps).where(eq(apps.id, token.appId)).get();
    let caps: string[] = [];
    if (app?.manifestJson) {
      try {
        const m = JSON.parse(app.manifestJson) as { capabilities?: unknown };
        if (Array.isArray(m.capabilities)) caps = m.capabilities.map(String);
      } catch {
        /* ignore */
      }
    }
    if (!caps.includes('llm')) {
      throw new HttpError(403, 'CAPABILITY_NOT_DECLARED', '该应用 manifest 未声明 llm 能力');
    }
    // 归因：SDK 透传运行身份头（invoked=运行用户；persistent=门户代理注入的请求身份），验签 aud=appId
    let userId: number | null = null;
    const idPayload = req.headers['x-aap-identity'];
    const idSig = req.headers['x-aap-identity-sig'];
    if (typeof idPayload === 'string' && typeof idSig === 'string') {
      const secret = getSetting('AAP_SIGN_SECRET');
      if (secret) {
        const v = verifyIdentity(idPayload, idSig, secret, token.appId);
        if (v.ok) userId = Number(v.payload.uid) || null;
      }
    }

    // 平台自签身份头转发网关（invoked：运行用户；persistent 无头时仅应用级计量）
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${(req.headers['x-aap-token'] as string) ?? ''}`,
    };
    if (userId !== null) {
      const user = getDb().select().from(users).where(eq(users.id, userId)).get();
      if (user) {
        const idn = signIdentity(
          {
            id: user.id,
            kind: user.kind === 'oidc' ? 'oidc' : 'local',
            subject: `local:${user.username ?? user.id}`,
            username: user.username,
            email: user.email,
            phone: user.phone,
            name: user.name,
            avatar: user.avatar,
            role: user.role === 'admin' ? 'admin' : 'user',
            status: user.status,
            sessionId: 'aap-egress',
            authState: 'full' as const,
            stepUpUntil: null,
            plan: user.plan === 'member' ? 'member' : 'free',
            mfaEnabled: Boolean(user.mfaEnabled),
            mustChangePassword: Boolean(user.mustChangePassword),
          },
          token.appId,
        );
        if (idn) {
          headers['x-aap-identity'] = idn.payload;
          headers['x-aap-identity-sig'] = idn.sig;
        }
      }
    }

    const gwRes = await fetch(`http://127.0.0.1:${config.port}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: body.messages,
        ...(body.model ? { model: body.model } : {}),
        ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      }),
    });
    const text = await gwRes.text();
    res.status(gwRes.status).type('application/json').send(text);
  }),
);
// ---------- aap.http.fetch 出站代理（白名单执行点） ----------

function hostAllowed(hostname: string, network: string[]): boolean {
  const host = hostname.toLowerCase();
  for (const entry of network) {
    const e = entry.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (host === e) return true;
    if (e.startsWith('*.')) {
      const suffix = e.slice(1); // .example.com
      if (host.endsWith(suffix) || host === suffix.slice(1)) return true;
    }
  }
  return false;
}

function isBlockedIpHost(hostname: string): boolean {
  // 防直连 IP 绕过白名单/SSRF 内网：IP 字面量一律拒绝（白名单域名走 DNS 由平台出站）
  if (net.isIP(hostname)) return true;
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  return false;
}

aapRouter.post(
  '/egress',
  h(async (req: Request, res: Response) => {
    const token = req.aapToken!;
    const body = (req.body ?? {}) as { url?: string };
    const url = String(body.url ?? '');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(400, 'INVALID_URL', 'URL 不合法');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new HttpError(400, 'INVALID_URL', '仅支持 http/https 出站');
    }
    const app = getDb().select().from(apps).where(eq(apps.id, token.appId)).get();
    let network: string[] = [];
    if (app?.manifestJson) {
      try {
        const m = JSON.parse(app.manifestJson) as { network?: unknown };
        if (Array.isArray(m.network)) network = m.network.map(String);
      } catch {
        /* ignore */
      }
    }
    if (!hostAllowed(parsed.hostname, network)) {
      throw new HttpError(403, 'EGRESS_DENIED', `域名 ${parsed.hostname} 不在该应用 manifest network 白名单内`);
    }
    if (isBlockedIpHost(parsed.hostname)) {
      throw new HttpError(403, 'EGRESS_DENIED', '禁止直连 IP/内网地址');
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const up = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'follow' });
      const text = (await up.text()).slice(0, 2 * 1024 * 1024);
      res.json({ status: up.status, body: text.slice(0, 500_000) });
    } catch (err) {
      throw new HttpError(504, 'EGRESS_FAILED', `出站请求失败：${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      clearTimeout(timer);
    }
  }),
);
