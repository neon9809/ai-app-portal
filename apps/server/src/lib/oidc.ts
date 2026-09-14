/**
 * OIDC 登录（A5）：openid-client v5 + PKCE S256 + state/nonce 一次性。
 * MFA 委托 IdP（A3 策略）；登录成功建 full 会话。
 * (kind, uid) 契约：统一 users 表 + subject 唯一列，无串号面。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { oidcStates } from '../db/schema.js';
import { HttpError } from './httpError.js';
import { getSetting } from './settings.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any;
let cachedClient: Client | null = null;

export function oidcEnabled(): boolean {
  return Boolean(
    getSetting('OIDC_ISSUER') && getSetting('OIDC_CLIENT_ID') && getSetting('OIDC_CLIENT_SECRET'),
  );
}

async function getClient(req: Request): Promise<Client> {
  if (cachedClient) return cachedClient;
  const issuerUrl = getSetting('OIDC_ISSUER')!;
  const { Issuer } = await import('openid-client');
  const issuer = await Issuer.discover(issuerUrl);
  // 兼容「声明 RFC 9207（iss 参数）但实际授权响应不回传 iss」的 IdP：
  // openid-client v5 会在 metadata 声明为 true 时硬性要求响应带 iss，缺失即抛
  // RPError 'iss missing from the response' 终止登录（实测 auth.xext.top 即此情况）。
  // 单 IdP 自托管场景下 mix-up 防护由 state 一次性校验承担，关闭该检查可接受。
  issuer.metadata.authorization_response_iss_parameter_supported = false;
  (issuer as unknown as Record<string, unknown>).authorization_response_iss_parameter_supported = false;
  cachedClient = new issuer.Client({
    client_id: getSetting('OIDC_CLIENT_ID')!,
    client_secret: getSetting('OIDC_CLIENT_SECRET')!,
    redirect_uris: [redirectUri(req)],
    response_types: ['code'],
  });
  return cachedClient;
}

/** IdP 侧注册的回调地址：同源 /api/auth/oidc/callback（反代下随 Host 自动适配） */
export function redirectUri(req: Request): string {
  const host = (req.headers.host ?? req.hostname) as string;
  return `${req.protocol}://${host}/api/auth/oidc/callback`;
}

export function oidcAdminSubjects(): string[] {
  return (getSetting('OIDC_ADMIN_SUBJECTS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 生成授权跳转 URL（PKCE + state/nonce 入库，10 分钟有效） */
export async function buildLoginRedirect(req: Request): Promise<string> {
  if (!oidcEnabled()) throw new HttpError(403, 'OIDC_DISABLED', 'OIDC 登录未配置');
  const client = await getClient(req);
  const state = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('hex');
  const codeVerifier = randomBytes(32).toString('hex');
  getDb()
    .insert(oidcStates)
    .values({
      state,
      nonce,
      codeVerifier,
      ip: req.clientIp ?? null,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60_000,
    })
    .run();
  return client.authorizationUrl({
    scope: getSetting('OIDC_SCOPES') || 'openid email profile',
    state,
    nonce,
    code_challenge: codeChallenge(codeVerifier),
    code_challenge_method: 'S256',
  });
}

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface OidcProfile {
  subject: string;
  email: string | null;
  name: string;
}

/** 回调校验（state 一次性 + nonce + PKCE）→ 用户资料 */
export async function exchangeCallback(
  req: Request,
  query: { code?: string; state?: string },
): Promise<OidcProfile> {
  const client = await getClient(req);
  const state = String(query.state ?? '');
  const row = getDb().select().from(oidcStates).where(eq(oidcStates.state, state)).get();
  if (!row) throw new HttpError(400, 'OIDC_STATE', '登录状态已失效，请重新发起登录');
  getDb().delete(oidcStates).where(eq(oidcStates.state, state)).run(); // 读后即删
  if (row.expiresAt <= Date.now()) throw new HttpError(400, 'OIDC_STATE_EXPIRED', '登录状态已过期');

  const ticket = await client.callback(redirectUri(req), { code: String(query.code ?? ''), state }, {
    state,
    nonce: row.nonce,
    code_verifier: row.codeVerifier,
  });
  const userinfo = (await client.userinfo(ticket.access_token)) as {
    sub?: string;
    email?: string;
    name?: string;
    preferred_username?: string;
  };
  const subject = String(userinfo.sub ?? '');
  if (!subject) throw new HttpError(502, 'OIDC_PROFILE', 'IdP 未返回 sub');
  return {
    subject,
    email: userinfo.email ?? null,
    name: userinfo.name || userinfo.preferred_username || userinfo.email || subject,
  };
}

export function isAdminSubject(profile: OidcProfile): boolean {
  return oidcAdminSubjects().includes(profile.subject) || oidcAdminSubjects().includes(profile.email ?? '');
}
