/**
 * .neon-aap 沙箱平台侧（M4，G2/G5）：
 *  - POST /api/aap/llm/chat   沙箱内 aap.llm.chat 的平台代理：转发网关并签名归因到运行用户
 *  - POST /api/aap/egress     沙箱内 aap.http.fetch 的唯一出口：manifest 域名白名单逐请求核验
 * 认证：X-AAP-Token（应用网关凭据，运行时由平台注入沙箱环境）。
 * 白名单执行点在平台代理侧，沙箱进程无法绕过（防 DNS rebinding/直连 IP）。
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import dns from 'node:dns';
import net from 'node:net';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { apps, users } from '../db/schema.js';
import { HttpError, h } from '../lib/httpError.js';
import { appLlmAllowed, resolveAppToken, resolveDefaultModel, type AppTokenRow } from '../lib/llm.js';
import { loopbackPlatformPort } from '../lib/sandbox.js';
import { signIdentity, verifyIdentity } from '../gateway/identity.js';
import { config } from '../config/index.js';
import { getSetting, getSettingInt } from '../lib/settings.js';

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
    // 能力声明校验（G1）：未声明 llm 的包不允许调用（与 /v1 网关同一判定，审计 F1）
    if (!appLlmAllowed(token.appId)) {
      throw new HttpError(403, 'CAPABILITY_NOT_DECLARED', '该应用 manifest 未声明 llm 能力');
    }
    // 规范 §3.1「不填用平台默认模型」：缺省取 LLM_DEFAULT_MODEL 设置，未设置取目录第一个
    let model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      model = resolveDefaultModel() ?? '';
      if (!model) {
        throw new HttpError(400, 'INVALID_INPUT', '未指定 model，且网关模型目录为空——请管理员先在「LLM 网关」配置模型路由（或在设置中指定沙箱默认模型）');
      }
    }
    // max_tokens：包显式指定优先；未指定时按 LLM_SANDBOX_MAX_TOKENS 注入（0 = 不限制，
    // 模型自然收尾，实际用量照常归因计量——推理型模型思考消耗大，由平台统一治理而非包内硬编码）
    let maxTokens: number | null = typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : null;
    if (maxTokens === null) {
      const configured = getSettingInt('LLM_SANDBOX_MAX_TOKENS', 0);
      if (configured > 0) maxTokens = configured;
    }
    // 归因：SDK 透传运行身份头（invoked=运行用户；persistent=门户代理注入的请求身份），验签 aud=appId
    let userId: number | null = null;
    const idPayload = req.headers['x-aap-identity'];
    const idSig = req.headers['x-aap-identity-sig'];
    if (typeof idPayload === 'string' && typeof idSig === 'string') {
      const secret = getSetting('AAP_SIGN_SECRET');
      if (secret) {
        // allowReplay：invoked 沙箱在一次运行内多次调用复用同一环境身份；
        // 重放防护由面向外部的网关侧验签承担
        const v = verifyIdentity(idPayload, idSig, secret, token.appId, { allowReplay: true });
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

    // 平台地址取明文 HTTP 环回口（TLS 到达时回落 config.port，同 appsRun 的
    // loopbackPlatformPort 修正：非常规端口部署不打空，TLS 口明文调用不悬断）
    const platformPort = loopbackPlatformPort(req.socket.localPort, config);
    const gwRes = await fetch(`http://127.0.0.1:${platformPort}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: body.messages,
        model,
        ...(maxTokens !== null ? { max_tokens: maxTokens } : {}),
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

/** 私网/保留段 IP 判定（IPv4 + IPv6）。对 DNS 解析结果逐条复核，防
 *  `127.0.0.1.nip.io` 类域名经白名单解析到内网（已实测 SSRF 利用路径）。 */
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7)); // v4 映射
    // fc00::/7 ULA、fe80::/10 链路本地、2001:db8::/32 文档段
    const first = parseInt(lower.split(':')[0] ?? 'ffff', 16);
    if ((first & 0xfe00) === 0xfc00) return true;
    if ((first & 0xffc0) === 0xfe80) return true;
    if (first === 0x2001 && (lower.startsWith('2001:db8:') || lower.startsWith('2001:db8::'))) return true;
    return false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true; // 非法格式按拒绝处理
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // 本网络/私网/环回
  if (a === 169 && b === 254) return true; // 链路本地（云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网
  if (a === 192 && b === 168) return true; // 私网
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24、192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试段
  if (a >= 224) return true; // 组播/保留/广播
  return false;
}

/** 解析域名全部 A/AAAA 记录；失败返回 null（按拒绝处理） */
function resolveHostIps(hostname: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err || !addrs || addrs.length === 0) resolve(null);
      else resolve(addrs.map((a) => a.address));
    });
  });
}

// ---------- 内网出站白名单（管理员级；供内网部署放行局域网目标） ----------

export interface IntranetAllowlist {
  /** 精确域名 / IP 字面量（小写） */
  hosts: Set<string>;
  /** IPv4 CIDR */
  cidrs: Array<{ net: number; prefix: number }>;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255 || !/^\d+$/.test(p)) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

export function parseIntranetAllowlist(raw: string | null | undefined): IntranetAllowlist {
  const hosts = new Set<string>();
  const cidrs: Array<{ net: number; prefix: number }> = [];
  for (const rawEntry of (raw ?? '').split(/[,\n;]+/)) {
    const entry = rawEntry.trim().toLowerCase().replace(/^https?:\/\//, '');
    if (!entry) continue;
    const [base, suffix] = entry.split('/');
    if (!base) continue;
    // 仅当「base 是 IPv4 且后缀是纯数字」才按 CIDR 解析；否则视为域名/IP 字面量
    if (suffix !== undefined && /^\d+$/.test(suffix)) {
      const net = ipv4ToInt(base);
      const prefix = Number(suffix);
      if (net === null || prefix < 0 || prefix > 32) continue;
      cidrs.push({ net, prefix });
    } else {
      hosts.add(base);
    }
  }
  return { hosts, cidrs };
}

export function ipInAllowCidr(ip: string, cidrs: IntranetAllowlist['cidrs']): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false; // IPv6 仅支持精确条目，不走 CIDR
  return cidrs.some(({ net, prefix }) => prefix === 0 || ((n ^ net) >>> (32 - prefix)) === 0);
}

/**
 * 单跳出站闸门：IP 字面量与内网主机名默认拒绝；管理员「内网出站白名单」
 * 命中（精确域名/IP 或 CIDR 覆盖）即完全放行——管理员权威高于包声明，
 * CIDR 区间无法要求包逐 IP 自我声明。未命中时包的 manifest network
 * 白名单照常生效。
 */
export function egressHostGate(
  hostname: string,
  network: string[],
  allow: IntranetAllowlist,
): { ok: true } | { ok: false; message: string } {
  const host = hostname.toLowerCase();
  const adminVouched = allow.hosts.has(host) || (net.isIP(host) && ipInAllowCidr(host, allow.cidrs));
  if (adminVouched) return { ok: true };
  if (net.isIP(host)) {
    return { ok: false, message: '禁止直连 IP/内网地址（如需内网出站，管理员可在「内网出站白名单」放行）' };
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, message: '禁止访问内网主机名（如需内网出站，管理员可在「内网出站白名单」放行）' };
  }
  if (!hostAllowed(host, network)) {
    return { ok: false, message: `域名 ${hostname} 不在该应用 manifest network 白名单内` };
  }
  return { ok: true };
}

const MAX_EGRESS_HOPS = 5;

aapRouter.post(
  '/egress',
  h(async (req: Request, res: Response) => {
    const token = req.aapToken!;
    const body = (req.body ?? {}) as { url?: string; headers?: Record<string, unknown> };
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
    // 包自定义请求头（如第三方 API 的鉴权头，密钥来自门户注入的环境变量，不落代码）：
    // 名称/数量/长度受限；逐跳与托管类头一律剥除（防流控/长度/代理语义被包改写）
    const HOP_BY_HOP = /^(host|connection|keep-alive|proxy-connection|transfer-encoding|te|trailer|upgrade|expect|content-length|content-type|proxy-authorization|proxy-authenticate|cookie2)$/i;
    let fwdHeaders: Record<string, string> | undefined;
    if (body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)) {
      fwdHeaders = {};
      for (const [k, v] of Object.entries(body.headers)) {
        if (Object.keys(fwdHeaders).length >= 16) break;
        if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || HOP_BY_HOP.test(k)) continue;
        fwdHeaders[k] = String(v).slice(0, 4096);
      }
      if (Object.keys(fwdHeaders).length === 0) fwdHeaders = undefined;
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

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const allow = parseIntranetAllowlist(getSetting('EGRESS_INTRANET_ALLOWLIST'));
    try {
      // 白名单与 IP 黑名单逐跳校验：redirect 用 manual 手动跟进，
      // 防白名单域名经 302 跳转内网/平台自身（SSRF 绕过）
      let current = parsed;
      for (let hop = 0; ; hop++) {
        if (hop > MAX_EGRESS_HOPS) {
          throw new HttpError(502, 'EGRESS_REDIRECT_LOOP', '出站重定向次数超限');
        }
        if (current.protocol !== 'http:' && current.protocol !== 'https:') {
          throw new HttpError(400, 'INVALID_URL', '仅支持 http/https 出站');
        }
        const gate = egressHostGate(current.hostname, network, allow);
        if (!gate.ok) {
          throw new HttpError(403, 'EGRESS_DENIED', gate.message);
        }
        // 解析后 IP 复核：白名单域名若指向内网/保留地址（nip.io 类 DNS 绕过）
        // 一律拦截；对全部 A/AAAA 记录判定。管理员「内网出站白名单」可放行：
        // 精确主机名（vouch 其全部解析）或 CIDR（覆盖解析 IP）。169.254/fe80 链路
        // 本地（云元数据）无条件拒绝。
        if (!net.isIP(current.hostname)) {
          const ips = await resolveHostIps(current.hostname);
          if (!ips) {
            throw new HttpError(403, 'EGRESS_DENIED', `域名 ${current.hostname} 无法解析`);
          }
          const linkLocal = ips.some((ip) => ip.startsWith('169.254.') || ip.toLowerCase().startsWith('fe80:'));
          if (linkLocal) {
            throw new HttpError(403, 'EGRESS_DENIED', '链路本地地址（云元数据段）始终拒绝');
          }
          const vouched = allow.hosts.has(current.hostname.toLowerCase());
          const uncovered = (ip: string): boolean => isPrivateIp(ip) && !ipInAllowCidr(ip, allow.cidrs);
          if (!vouched && ips.some(uncovered)) {
            throw new HttpError(403, 'EGRESS_DENIED', `域名 ${current.hostname} 解析到内网/保留地址，已拦截`);
          }
        }
        const up = await fetch(current.toString(), { method: 'GET', signal: ctrl.signal, redirect: 'manual', headers: fwdHeaders });
        const loc = up.status >= 300 && up.status < 400 ? up.headers.get('location') : null;
        if (loc) {
          up.body?.cancel();
          current = new URL(loc, current);
          continue;
        }
        const text = (await up.text()).slice(0, 2 * 1024 * 1024);
        res.json({ status: up.status, body: text.slice(0, 500_000) });
        return;
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // 错误详情（DNS/连接错误信息可作内网探测 oracle）只进服务端日志，不回传调用者
      console.error('[aap] egress failed:', err instanceof Error ? err.message : err);
      throw new HttpError(504, 'EGRESS_FAILED', '出站请求失败');
    } finally {
      clearTimeout(timer);
    }
  }),
);
