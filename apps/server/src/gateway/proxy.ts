/**
 * 路径反向代理（B1）——移植自参考实现 routes/proxy.js（office-tool 实战验证），
 * 前缀改为 /app/<id>/，剥除单位指纹。保留全部关键语义：
 *  1. HTML 改写：href/src/poster/action/srcset 的根绝对路径 → /app/<id>/...
 *  2. <base> 注入修正相对链接（path 型凭据上游取凭据目录，其余指根）
 *  3. 猴补丁脚本：history.replaceState 剥前缀 + fetch/XHR/script.src 改写
 *  4. Link/Location 头改写（仅同源 Location）
 *  5. 路径穿越逐段黑名单（原文 + decoded 双查；URL 构造器会吃掉 ..）
 *  6. 入口请求保留上游 base path 与 query；资源请求直接映射上游根
 *  7. undici duplex:'half'（非 GET 带 ReadableStream body 必须，否则全 502）
 *  8. SSE/流式零缓冲 pipe；客户端断开销毁；no-store
 *  9. 请求/响应头过滤（凭据、cookie、CSP/XFO、set-cookie 等）
 * 10. 30s 超时仅覆盖 TTFB/HTML 拉取（pipe 启动后清除），不断流式连接
 */
import { Readable } from 'node:stream';
import path from 'node:path';
import express, { Router, type Request, type Response } from 'express';
import { config } from '../config/index.js';
import { canAccess, findApp, getUrlSecret, isSlug, type UrlSecret } from './registry.js';
import { signIdentity } from './identity.js';
import { allowRequest } from './limiter.js';
import { getSettingInt } from '../lib/settings.js';
import { injectChrome, serveHtmlApp, serveSandboxShell, needsIframeSandbox, stripRawPrefix } from './staticApp.js';
import { ensurePersistent, touchByPort } from '../lib/sandbox.js';
import { missingRequiredEnv } from '../lib/appEnv.js';
import http from 'node:http';

export const gatewayRouter = Router();

// 不转发给上游的请求头（x-aap-identity* 也在列：客户端自带的身份头一律剥除，
// 仅在 passUser 启用时由网关注入重新签名的身份头，防伪造）
const REQ_SKIP = new Set([
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
  'x-aap-identity',
  'x-aap-identity-sig',
]);
// 不回传给客户端的响应头
const RESP_STRIP = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'set-cookie',
  'strict-transport-security',
  'access-control-allow-origin',
]);

function decodeSafe(sub: string): string {
  try {
    return decodeURIComponent(sub);
  } catch {
    return sub;
  }
}

/** HTML 转义：错误页插入路由参数/应用名（含用户可控的 display_name）前必须转义（防反射/存储 XSS） */
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}

function htmlError(res: Response, status: number, title: string, detail: string): void {
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
        `<body style="font-family:system-ui;display:grid;place-items:center;min-height:80vh">` +
        `<div style="text-align:center"><h1>${status}</h1><p>${escapeHtml(title)}</p><p style="color:#888">${escapeHtml(detail)}</p></div>`,
    );
}

/** 根绝对路径(/xxx) → /app/<id>/xxx；query 型凭据参数不在此处理 */
function proxyUrl(id: string, url: string, prefix: string): string {
  if (typeof url !== 'string') return url;
  const u = url.trim();
  if (u.startsWith('//') || u.startsWith(prefix) || !u.startsWith('/')) return url;
  return prefix + u;
}

function rewriteHtml(html: string, id: string, prefix: string): string {
  html = html.replace(
    /(\b(?:href|src|poster|action)\s*=\s*["'])([^"']*)(["'])/gi,
    (_m, pre: string, val: string, post: string) => pre + proxyUrl(id, val, prefix) + post,
  );
  html = html.replace(
    /(\bsrcset\s*=\s*["'])([^"']*)(["'])/gi,
    (_m, pre: string, val: string, post: string) => {
      const out = val
        .split(',')
        .map((part) => {
          const seg = part.trim().split(/\s+/);
          seg[0] = proxyUrl(id, seg[0] ?? '', prefix);
          return seg.join(' ');
        })
        .join(', ');
      return pre + out + post;
    },
  );
  return html;
}

function rewriteLinkHeader(value: string, id: string, prefix: string): string {
  return String(value).replace(/<([^>]+)>/g, (m, url: string) => `<${proxyUrl(id, url.trim(), prefix)}>`);
}

function rewriteLocation(loc: string, id: string, base: URL, prefix: string): string {
  try {
    const abs = new URL(loc, base);
    if (abs.origin === base.origin) {
      return `${prefix}${abs.pathname}${abs.search}${abs.hash}`;
    }
    return loc;
  } catch {
    return loc;
  }
}

/** 计算入口/资源/凭据三者合成的上游目标 URL；路径非法返回 null */
function buildTarget(req: Request, base: URL, secret: UrlSecret | null): URL | null {
  const sub = (req.params[0] as string | undefined) ?? '';

  // 路径穿越防御：URL 构造器会归一化吃掉 ..，必须对原文与 decoded 逐段拒绝
  const subDecoded = (() => {
    try {
      return decodeURIComponent(sub);
    } catch {
      return sub;
    }
  })();
  const hasDotSegment = (s: string): boolean =>
    s.split('/').some((seg) => seg === '.' || seg === '..');
  if (hasDotSegment(sub) || hasDotSegment(subDecoded)) return null;

  let target: URL;
  if (sub) {
    // 资源请求：映射到上游根路径（不能拼 base.pathname，否则子路径部署的上游
    // 静态资源 404 且上游 SPA 回退返回 text/html 触发 MIME 报错——参考实现踩坑）
    target = new URL('/' + sub.replace(/^\/+/, ''), base.origin);
  } else {
    // 入口请求：保留上游 url 的 base path（子路径部署与入口路由）
    target = new URL(base.pathname || '/', base.origin);
  }
  // query 合并：上游 url 自带 ∪ 本次请求（请求侧优先）
  for (const [k, v] of base.searchParams) {
    if (!target.searchParams.has(k)) target.searchParams.set(k, v);
  }
  const qIndex = req.url.indexOf('?');
  if (qIndex >= 0) {
    for (const [k, v] of new URLSearchParams(req.url.slice(qIndex + 1))) {
      target.searchParams.set(k, v as string);
    }
  }
  // urlSecret 注入：path 型替换上游 path（sub 拼其后）；query 型拼参数
  if (secret && secret.name === null) {
    const secretPath = secret.value.replace(/\/+$/, '');
    target.pathname = secretPath + (sub ? '/' + sub.replace(/^\/+/, '') : '');
    const reqQuery = qIndex >= 0 ? req.url.slice(qIndex + 1) : '';
    target.search = reqQuery; // 丢弃 url 自带旧 query（可能含占位/旧凭据），保留本次请求参数
  } else if (secret && secret.name !== null) {
    target.searchParams.set(secret.name, secret.value);
  }
  return target;
}

function filterRequestHeaders(
  req: Request,
  base: URL,
  identity: { payload: string; sig: string } | null,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (REQ_SKIP.has(k.toLowerCase())) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : (v ?? '');
  }
  headers['host'] = base.host;
  if (identity) {
    headers['x-aap-identity'] = identity.payload;
    headers['x-aap-identity-sig'] = identity.sig;
  }
  return headers;
}

gatewayRouter.get('/app/:id', (req, res, next) => {
  // strict routing 关闭时 /app/:id 也会匹配带尾斜杠的 /app/<id>/——
  // 那是入口请求（目录形态，<base> 依赖它），必须放行给反代路由
  if ((req.originalUrl ?? req.url).endsWith('/')) return next();
  // 裸 /app/<id> → 补斜杠（<base> 相对链接解析依赖目录形态）
  res.redirect(301, `/app/${encodeURIComponent(String(req.params.id))}/`);
});

gatewayRouter.all('/app/:id/*', async (req: Request, res: Response) => {
  if (!config.proxyEnabled) return htmlError(res, 404, 'Not Found', '应用网关未启用');

  const id = String(req.params.id);
  // 与 WS 通道（wsproxy 正则）对齐：非法 id 不进 DB 查询，也不回显到错误页
  if (!isSlug(id)) return htmlError(res, 404, 'Not Found', '应用不存在');
  const app = findApp(id);
  if (!app || !app.enabled) {
    return htmlError(res, 404, '应用不存在', `未找到应用 ${id} 或已被停用`);
  }

  // 访问策略三态
  const user = req.user;
  if (!canAccess(app, user ?? null)) {
    if (!user) {
      return htmlError(res, 403, '需要登录', `应用「${app.name}」需要登录后访问，<a href="/login">去登录</a>`);
    }
    if (user.authState !== 'full') {
      return htmlError(res, 403, '需要完成验证', '请先完成多因子认证');
    }
    return htmlError(res, 403, '无权访问', `应用「${app.name}」未对你所在的分组或账号开放`);
  }

  // 双维度限流
  const userKey = user ? `${user.kind}:${user.id}` : null;
  if (!allowRequest(userKey, req.clientIp ?? 'unknown')) {
    return htmlError(res, 429, '请求过于频繁', '请稍后再试');
  }

  // 门户托管应用（简单 HTML / .neon-aap 包）不走上游
  if (app.kind !== 'upstream') {
    const sub0 = decodeSafe((req.params[0] as string | undefined) ?? '');
    // 用户上传包（归属者非管理员）经 iframe 沙箱隔离（PRD G1）：
    // 外壳层挂统一页面元素；内容只经 /raw/ 通道输出（不直出门户源）
    const sandboxed = needsIframeSandbox(app);
    const inRaw = sandboxed && /^raw\/?/.test(sub0);
    if (sandboxed && !inRaw) return serveSandboxShell(res, app.id, sub0);

    if (app.kind === 'package' && app.runtimeMode === 'persistent') {
      // G2 persistent：拉起长驻沙箱并反代（纳入 B 域门禁/限流/审计）
      // 必填环境变量未配置 → 不拉起，给可操作的错误页（而不是让应用起来后行为异常）
      const missing = missingRequiredEnv(app.id);
      if (missing.length > 0) {
        return htmlError(res, 503, '应用缺少配置', `必填环境变量未配置：${missing.join('、')}。请由归属者或管理员在应用「环境变量」中填写后重试。`);
      }
      const port = await ensurePersistent(app.id, manifestEntry(app), () => {
        console.log(`[sandbox] persistent 崩溃重启: ${app.id}`);
      });
      if (!port) return htmlError(res, 503, '应用启动中', '请稍后重试');
      // passUser：为沙箱逐请求签名注入身份头（persistent 内 LLM 调用按浏览用户归因计费）
      const identity = app.passUser && user ? signIdentity(user, app.id) : null;
      return proxyToSandbox(req, res, port, inRaw ? stripRawPrefix(sub0) : sub0, identity, app.id);
    }
    const sub = inRaw ? stripRawPrefix(sub0) : sub0;
    return serveHtmlApp(req, res, app, sub, inRaw);
  }

  const base = (() => {
    try {
      return new URL(app.upstream);
    } catch {
      return null;
    }
  })();
  if (!base) {
    return htmlError(res, 502, '上游地址无效', '请检查应用配置');
  }
  const secret = getUrlSecret(app);
  const target = buildTarget(req, base, secret);
  if (!target) {
    return htmlError(res, 400, '非法路径', '路径包含非法段');
  }
  const prefix = `/app/${encodeURIComponent(id)}`;

  // passUser：注入签名身份头（未登录/未配置密钥时不注入）
  const identity = app.passUser && user ? signIdentity(user, app.id) : null;
  const headers = filterRequestHeaders(req, base, identity);

  const timeoutSec = getSettingInt('PROXY_TIMEOUT', config.proxyTimeoutSec);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutSec * 1000);
  try {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Readable.toWeb(req);
    // duplex:'half'：body 为 ReadableStream 时必须显式声明，否则
    // POST/PUT/PATCH/DELETE 全部 502 而 GET 正常（undici 的硬约束）
    const upstream = await fetch(target.toString(), {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: ctrl.signal,
      ...(body ? { duplex: 'half' } : {}),
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (RESP_STRIP.has(k)) return;
      if (k === 'link') {
        res.setHeader(key, rewriteLinkHeader(value, id, prefix));
        return;
      }
      res.setHeader(key, value);
    });
    const loc = upstream.headers.get('location');
    if (loc) res.setHeader('Location', rewriteLocation(loc, id, base, prefix));
    res.setHeader('Cache-Control', 'no-store');

    const ct = (upstream.headers.get('content-type') ?? '').toLowerCase();
    if (ct.includes('text/html')) {
      // HTML 全量缓冲改写（超大页面有内存代价——参考实现同语义）
      let html = Buffer.from(await upstream.arrayBuffer()).toString('utf8');
      html = rewriteHtml(html, id, prefix);
      // <base> 指向「资源在上游的真实挂载点」：query 型凭据工具的资源在根，
      // 只有 path 型凭据才取凭据目录
      const basePathForRel = secret && secret.name === null ? secret.value : '/';
      let dir = path.posix.dirname(basePathForRel).replace(/^\//, '');
      if (dir && !dir.endsWith('/')) dir += '/';
      const baseTag = `<base href="${prefix}/${dir}">`;
      // 猴补丁：a) 剥代理前缀让 history 路由匹配；b) 同源根绝对路径请求
      // （SPA 的后端 API、Next.js chunk 等）全部改写进代理前缀
      const routeFix = `<script>(function(){
  try{
    var PREFIX=${JSON.stringify(prefix)};
    var m=location.pathname.match(/^\\/app\\/[^\\/]+/);
    if(m){var p=location.pathname.slice(m[0].length)||"/";history.replaceState(history.state,"",p+location.search+location.hash);}
    var isAbs=function(u){return typeof u==="string"&&u.charAt(0)==="/"&&u.charAt(1)!=="/"&&u.indexOf(PREFIX)!==0;};
    var fix=function(u){return isAbs(u)?PREFIX+u:u;};
    var _open=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(mt,url){if(isAbs(url)){arguments[1]=fix(url);}return _open.apply(this,arguments);};
    var _fetch=window.fetch;
    window.fetch=function(u,o){return _fetch.call(this,fix(u),o);};
    var _desc=Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,"src");
    if(_desc&&_desc.set){Object.defineProperty(HTMLScriptElement.prototype,"src",{get:_desc.get,set:function(v){return _desc.set.call(this,fix(v));}});}
  }catch(e){}
})();</script>`;
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}${routeFix}`);
      } else {
        html = baseTag + routeFix + html;
      }
      // 统一页面元素（P3）：应用门户 / 个人中心 / 退出登录（幂等、失败静默）
      html = injectChrome(html, id);
      return res.send(html);
    }

    if (upstream.body) {
      const rs = Readable.fromWeb(upstream.body);
      // 客户端断开或上游流错误时避免未处理 error 事件导致进程崩溃
      rs.on('error', () => {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      });
      res.on('close', () => rs.destroy());
      rs.pipe(res);
      return;
    }
    return res.end();
  } catch (err) {
    if (!res.headersSent) return htmlError(res, 502, '网关错误', '上游不可达或超时');
    try {
      res.end();
    } catch {
      /* ignore */
    }
    void err;
  } finally {
    clearTimeout(timer);
  }
});


// ---------- persistent 沙箱反代（HTTP；WS 由 upgrade 通道类似处理，M4 后续补齐） ----------

export function manifestEntry(app: { manifestJson: string | null }): string {
  if (!app.manifestJson) return 'mod.py';
  try {
    const m = JSON.parse(app.manifestJson) as { entry?: string };
    return m.entry || 'mod.py';
  } catch {
    return 'mod.py';
  }
}

function proxyToSandbox(
  req: Request,
  res: Response,
  port: number,
  sub: string,
  identity: { payload: string; sig: string } | null,
  appId: string,
): void {
  touchPersistentByPort(port);
  // 沙箱跑的是用户上传代码（不可信）：与 upstream 反代同一张剥离表，
  // 会话 cookie / 凭据 / 自带身份头一律不下发沙箱；身份头仅由网关
  // 在 passUser 启用时重新签名注入（persistent 内 LLM 归因用）
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (REQ_SKIP.has(k.toLowerCase())) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : (v ?? '');
  }
  if (identity) {
    headers['x-aap-identity'] = identity.payload;
    headers['x-aap-identity-sig'] = identity.sig;
  }
  // 沙箱外壳 raw 通道：剥掉 raw 段，沙箱看到的路径与既往一致（/app/<id>/...）
  const rawStripped = (req.originalUrl ?? req.url ?? '/').replace(
    /^(\/app\/[^/]+)\/raw(?=\/|\/?\?|$)/,
    '$1',
  );
  // 沙箱路由挂根路径（规范 §二 persistent 模板即 @app.route("/")）：剥掉
  // /app/<id> 前缀再转发，前缀经 x-forwarded-prefix 交给包（拼绝对 URL 用）；
  // 否则包作者要在自己的 mod.py 里逐个兼容挂载前缀
  const prefix = `/app/${encodeURIComponent(appId)}`;
  let pathAndQuery = rawStripped;
  if (pathAndQuery === prefix) pathAndQuery = '/';
  else if (pathAndQuery.startsWith(`${prefix}/`)) pathAndQuery = pathAndQuery.slice(prefix.length);
  headers['x-forwarded-prefix'] = prefix;
  const up = http.request(
    { hostname: '127.0.0.1', port, path: pathAndQuery, method: req.method, headers },
    (upRes) => {
      res.status(upRes.statusCode ?? 502);
      // 响应头同一张剥离表：沙箱不得给浏览器种 cookie（cookie tossing 固定会话）
      // 或覆盖 CSP/XFO 等安全头
      for (const [key, value] of Object.entries(upRes.headers)) {
        if (value === undefined) continue;
        if (RESP_STRIP.has(key.toLowerCase())) continue;
        // 沙箱按根路径产生的站内相对 Location 重写回挂载前缀（镜像路径剥离）
        if (key.toLowerCase() === 'location' && typeof value === 'string' && value.startsWith('/')) {
          res.setHeader(key, prefix + value);
          continue;
        }
        if (Array.isArray(value)) res.setHeader(key, value);
        else res.setHeader(key, value);
      }
      upRes.pipe(res);
    },
  );
  up.on('error', () => {
    if (!res.headersSent) res.status(502).type('html').send('sandbox error');
    else res.end();
  });
  req.pipe(up);
}

function touchPersistentByPort(port: number): void {
  touchByPort(port);
}
