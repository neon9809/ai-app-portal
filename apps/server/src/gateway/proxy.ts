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
import { canAccess, findApp, getUrlSecret, type UrlSecret } from './registry.js';
import { signIdentity } from './identity.js';
import { allowRequest } from './limiter.js';
import { getSettingInt } from '../lib/settings.js';
import { injectChrome, serveHtmlApp } from './staticApp.js';

export const gatewayRouter = Router();

// 不转发给上游的请求头
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

function htmlError(res: Response, status: number, title: string, detail: string): void {
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
        `<body style="font-family:system-ui;display:grid;place-items:center;min-height:80vh">` +
        `<div style="text-align:center"><h1>${status}</h1><p>${title}</p><p style="color:#888">${detail}</p></div>`,
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

  // 门户托管应用（简单 HTML / .neon-aap html 包 / 等待运行时的包）不走上游
  if (app.kind !== 'upstream') {
    const sub = decodeSafe((req.params[0] as string | undefined) ?? '');
    return serveHtmlApp(req, res, app, sub);
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
