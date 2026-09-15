/**
 * WebSocket 透传（B2，P0）：HTTP/HTTPS server 的 upgrade 事件 →
 * /app/<id>/ 前缀匹配 → 会话鉴权（裸 req cookie 解析）→ 三态门禁 →
 * 限流 → TCP 双向管道（手写 101 + pipe；上游拒绝时回写状态并销毁）。
 * 上游路径映射与 HTTP 代理一致：sub → 上游根 + path 型凭据前缀。
 */
import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { IDENTITY_TTL_MS } from '@aap/shared';
import { canAccess, findApp, getUrlSecret, type AppRow, type UrlSecret } from './registry.js';
import { signIdentity } from './identity.js';
import { allowRequest } from './limiter.js';
import { loadSessionByToken } from '../lib/session.js';
import { ensurePersistent, touchByPort } from '../lib/sandbox.js';
import { manifestEntry } from './proxy.js';
import { config } from '../config/index.js';
import type { SessionUser } from '../types.js';

const REQ_SKIP = new Set(REQ_SKIP_KEYS());

function REQ_SKIP_KEYS(): string[] {
  return [
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'keep-alive',
    'cookie',
    'authorization',
    'origin',
    'referer',
    'x-forwarded-for',
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-extensions',
    'sec-websocket-protocol',
    'upgrade',
    // 身份头仅由网关注入（与 HTTP 代理剥离表一致），不接受客户端自带
    'x-aap-identity',
    'x-aap-identity-sig',
  ];
}

/** 从裸 Cookie 头取会话 token（复用 session 哈希查询；cookie 名与配置保持一致） */
function userFromCookieHeader(cookieHeader: string | undefined): SessionUser | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === config.sessionCookieName) return loadSessionByToken(part.slice(eq + 1).trim());
  }
  return null;
}

function reject(socket: Duplex, code: number, reason: string): void {
  const body = `HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
  socket.end(body);
  socket.destroy();
}

export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  Promise.resolve()
    .then(() => upgrade(req, socket, head))
    .catch((err) => {
      console.error('[wsproxy] upgrade error:', err);
      reject(socket, 500, 'Internal Server Error');
    });
}

async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal.invalid');
  const m = url.pathname.match(/^\/app\/([a-z0-9][a-z0-9-]*)(\/.*)?$/);
  if (!m) return reject(socket, 404, 'Not Found');

  // CSWSH 防护：同站/同父域页面发起的跨源 WS 握手会携带 SameSite=Lax cookie，
  // 且 WS 响应读取不受 SOP 限制——与 /api CSRF 同语义校验 Origin：
  // 缺失（非浏览器客户端，SDK/CLI）放行；存在则必须与 Host 精确相等。
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      /* 非法 Origin → 落到 403 */
    }
    if (!originHost || originHost !== req.headers.host) return reject(socket, 403, 'Forbidden');
  }

  const id = m[1]!;
  const sub = (m[2] ?? '/').replace(/^\/+/, '');

  const app: AppRow | null = findApp(id);
  if (!app || !app.enabled) return reject(socket, 404, 'Not Found');

  const user = userFromCookieHeader(req.headers.cookie);
  if (!canAccess(app, user ?? null)) {
    return reject(socket, user ? 403 : 401, user ? 'Forbidden' : 'Unauthorized');
  }

  const userKey = user ? `${user.kind}:${user.id}` : null;
  const ip = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
  if (!allowRequest(userKey, ip)) return reject(socket, 429, 'Too Many Requests');

  // 目标三类：upstream 反代 / persistent 沙箱（HTTP + WS 同门禁同语义）/ 其它形态不支持 WS
  let hostname: string;
  let port: string | number;
  let hostHeader: string;
  let requestPath: string;
  let transport: typeof http | typeof https;

  if (app.kind === 'package' && app.runtimeMode === 'persistent') {
    // G2 persistent：拉起长驻沙箱并把 WS 透传到沙箱端口；路径与 HTTP 反代一致（原样含 /app/<id>/ 前缀；
    // 沙箱外壳 raw 通道同理剥除 raw 段）
    const sandboxPort = await ensurePersistent(app.id, manifestEntry(app), (aid, restarts) => {
      console.log(`[sandbox] persistent 崩溃重启: ${aid} (${restarts})`);
    });
    if (!sandboxPort) return reject(socket, 503, 'Service Unavailable');
    touchByPort(sandboxPort);
    hostname = '127.0.0.1';
    port = sandboxPort;
    hostHeader = `127.0.0.1:${sandboxPort}`;
    requestPath = (req.url ?? '/').replace(/^(\/app\/[^/]+)\/raw(?=\/|\/?\?|$)/, '$1');
    transport = http;
  } else if (app.kind === 'upstream') {
    let base: URL;
    try {
      base = new URL(app.upstream.replace(/^http/i, 'ws'));
    } catch {
      return reject(socket, 502, 'Bad Gateway');
    }

    // 上游路径：path 型凭据前缀 + sub（映射到上游根，与 HTTP 代理同语义）
    const secret: UrlSecret | null = getUrlSecret(app);
    const secretPath = secret && secret.name === null ? secret.value.replace(/\/+$/, '') : '';
    const upstreamPath = `${secretPath}/${sub}`.replace(/\/{2,}/g, '/');

    // query 合并：上游自带 ∪ 请求侧（请求侧优先）
    const target = new URL(upstreamPath || '/', base);
    for (const [k, v] of base.searchParams) if (!target.searchParams.has(k)) target.searchParams.set(k, v);
    for (const [k, v] of url.searchParams) target.searchParams.set(k, v);

    const isTls = base.protocol === 'wss:';
    hostname = base.hostname;
    port = base.port || (isTls ? 443 : 80);
    hostHeader = base.host;
    requestPath = `${target.pathname}${target.search}`;
    transport = isTls ? https : http;
  } else {
    return reject(socket, 404, 'Not Found');
  }

  const identity = app.passUser && user ? signIdentity(user, app.id) : null;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (REQ_SKIP.has(k.toLowerCase())) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : (v ?? '');
  }
  headers['host'] = hostHeader;
  if (identity) {
    headers['x-aap-identity'] = identity.payload;
    headers['x-aap-identity-sig'] = identity.sig;
  }

  const upReq = transport.request(
    {
      hostname,
      port,
      path: requestPath,
      headers: {
        ...headers,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': req.headers['sec-websocket-key'] as string,
        'sec-websocket-version': req.headers['sec-websocket-version'] as string,
        ...(req.headers['sec-websocket-protocol']
          ? { 'sec-websocket-protocol': req.headers['sec-websocket-protocol'] as string }
          : {}),
        ...(req.headers['sec-websocket-extensions']
          ? { 'sec-websocket-extensions': req.headers['sec-websocket-extensions'] as string }
          : {}),
      },
    },
  );

  upReq.on('upgrade', (upRes: IncomingMessage, upSocket: Duplex, upHead: Buffer) => {
    // 手写 101：把上游的握手响应原样回给客户端，随后双向裸管道
    let resp = `HTTP/1.1 101 Switching Protocols\r\n`;
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (Array.isArray(v)) for (const item of v) resp += `${k}: ${item}\r\n`;
      else resp += `${k}: ${v}\r\n`;
    }
    resp += '\r\n';
    socket.write(resp);
    if (upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);

    const kill = (): void => {
      upSocket.destroy();
      socket.destroy();
    };
    upSocket.on('error', kill);
    socket.on('error', kill);
    upSocket.on('close', () => socket.destroy());
    socket.on('close', () => upSocket.destroy());
  });

  // 上游拒绝升级（返回普通 HTTP 响应）
  upReq.on('response', (res: ServerResponse | IncomingMessage) => {
    const r = res as IncomingMessage;
    let head = `HTTP/1.1 ${r.statusCode} ${r.statusMessage ?? ''}\r\n`;
    for (const [k, v] of Object.entries(r.headers)) {
      if (Array.isArray(v)) for (const item of v) head += `${k}: ${item}\r\n`;
      else head += `${k}: ${v}\r\n`;
    }
    socket.end(`${head}\r\n`);
  });

  upReq.on('error', (err) => {
    console.error('[wsproxy] upstream error:', err.message);
    reject(socket, 502, 'Bad Gateway');
  });
  socket.on('error', () => upReq.destroy());

  if (head.length) upReq.write(head);
  upReq.end();
  void IDENTITY_TTL_MS;
}
