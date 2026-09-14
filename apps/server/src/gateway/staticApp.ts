/**
 * 门户托管静态应用（P4）与应用统一页面元素（P3）。
 *  - kind='html'：门户直接托管 data/appsites/<id>/（简单 HTML 页 / .neon-aap html 包）
 *  - kind='package'：python 包等待运行时（M4），占位页
 *  - 统一页面元素：HTML 响应注入 /portal-chrome.js（应用门户 / 个人中心 / 退出登录），
 *    失败静默不阻断（W0 契约：包作者不得遮挡右上角）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { config } from '../config/index.js';
import { getDb } from '../db/index.js';
import { users } from '../db/schema.js';
import type { AppRow } from './registry.js';

export function appSiteDir(appId: string): string {
  return path.join(config.dataDir, 'appsites', appId);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 写入托管应用的入口 HTML（简单 HTML 页接入） */
export function writeHtmlApp(appId: string, html: string): void {
  const dir = appSiteDir(appId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
}

/** 解压 .neon-aap（html 包）到托管目录，返回解出的文件数与签名材料。
 *  entries 不含 signature.json（供规范化摘要计算）；signature 为包内自带签名（可能为 null）。 */
export function storePackageFiles(
  appId: string,
  zipBuffer: Buffer,
): {
  files: number;
  manifest: Record<string, unknown>;
  entries: Array<{ name: string; content: Buffer }>;
  signature: Record<string, unknown> | null;
} {
  // adm-zip 延迟加载（纯 JS，无原生依赖）
  const req = createRequire(import.meta.url);
  type ZipEntry = { entryName: string; isError: boolean; getData: () => Buffer };
  const AdmZip = req('adm-zip') as new (b: Buffer) => { getEntries(): ZipEntry[] };
  const zip = new AdmZip(zipBuffer);
  const dir = appSiteDir(appId);
  fs.mkdirSync(dir, { recursive: true });
  let files = 0;
  let manifest: Record<string, unknown> | null = null;
  let signature: Record<string, unknown> | null = null;
  const entries: Array<{ name: string; content: Buffer }> = [];
  for (const entry of zip.getEntries()) {
    if (entry.isError) continue;
    const name = entry.entryName.replace(/\\/g, '/');
    if (name.includes('..') || name.startsWith('/') || name.endsWith('/')) continue;
    const dest = path.join(dir, name);
    // 防压缩包路径逃逸：relative 结果必须是 dir 内部相对路径
    // （startsWith(dir) 缺路径分隔符，"x" 可匹配兄弟目录 "x-secret"，已实测绕过）
    const rel = path.relative(dir, dest);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const content = entry.getData();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    files++;
    if (name === 'signature.json') {
      // 签名不参与摘要；原样落盘（自描述），解析失败按未签名处理
      try {
        signature = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
      } catch {
        signature = { alg: 'broken' };
      }
      continue;
    }
    entries.push({ name, content });
    if (name === 'manifest.json') {
      try {
        manifest = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
      } catch {
        throw new Error('manifest.json 不是合法 JSON');
      }
    }
  }
  if (!manifest) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('包内缺少 manifest.json');
  }
  return { files, manifest, entries, signature };
}

/** 校验 .neon-aap manifest（app-develop.skill v0.2 契约），返回规范化字段 */
export function validateManifest(m: Record<string, unknown>): {
  name: string;
  displayName: string;
  version: string;
  type: 'html' | 'python';
  entry: string;
  runtime: string;
  capabilities: string[];
  network: string[];
  route: string | null;
} {
  const name = String(m.name ?? '');
  const type = String(m.type ?? '');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('manifest.name 需为小写字母/数字/连字符');
  if (type !== 'html' && type !== 'python') throw new Error('manifest.type 必须是 html 或 python');
  const entry = String(m.entry ?? (type === 'html' ? 'index.html' : ''));
  if (type === 'python' && !entry) throw new Error('python 包必须声明 entry');
  const runtime = String(m.runtime ?? 'invoked');
  if (type === 'python' && !['invoked', 'persistent'].includes(runtime)) throw new Error('manifest.runtime 非法');
  const caps = Array.isArray(m.capabilities) ? m.capabilities.map(String) : [];
  for (const c of caps) {
    if (!['llm', 'db', 'storage'].includes(c)) throw new Error(`未知能力声明: ${c}`);
  }
  const network = Array.isArray(m.network) ? m.network.map(String) : [];
  const route = m.route ? String(m.route) : null;
  // display_name 会出现在门户卡片与网关错误页：限长并剥除 HTML 敏感字符（纵深，
  // 输出侧另有 escapeHtml 兜底）
  const displayName = String(m.display_name ?? name)
    .replace(/[<>"'`]/g, '')
    .trim()
    .slice(0, 64) || name;
  return {
    name,
    displayName,
    version: String(m.version ?? '0.0.0'),
    type,
    entry,
    runtime,
    capabilities: caps,
    network,
    route,
  };
}

/**
 * 用户上传的 html/package 应用必须经 iframe 沙箱隔离（PRD G1：iframe sandbox
 * 属性 + 禁同源 cookie）。判据：归属者存在且不是管理员——管理员自建应用视为
 * 信任内容，保持既往直出行为。沙箱（无 allow-same-origin）下包代码运行在
 * opaque origin：读 /api 受 CORS 拦、写 /api 受 CSRF Origin(null) 拦。
 */
export function needsIframeSandbox(app: AppRow): boolean {
  if (app.kind !== 'html' && app.kind !== 'package') return false;
  if (app.ownerUserId == null) return false;
  const owner = getDb().select({ role: users.role }).from(users).where(eq(users.id, app.ownerUserId)).get();
  return owner?.role !== 'admin';
}

/** raw 通道前缀：沙箱外壳内 iframe 加载 /app/<id>/raw/…（内容不经门户源直出） */
const RAW_PREFIX_RE = /^raw\/?/;

export function stripRawPrefix(sub: string): string {
  return sub.replace(RAW_PREFIX_RE, '');
}

/** 沙箱外壳页：iframe sandbox 承载包内容，统一页面元素挂在外壳层（包代码不可触碰） */
export function serveSandboxShell(res: Response, appId: string, sub: string): void {
  const enc = stripRawPrefix(sub)
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/');
  const target = `/app/${encodeURIComponent(appId)}/raw/${enc}`;
  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%}</style>` +
    `<script src="/portal-chrome.js" data-aap-app="${encodeURIComponent(appId)}" defer></script>` +
    `</head><body>` +
    `<iframe sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock" ` +
    `referrerpolicy="no-referrer" src="${target}" title="app"></iframe></body></html>`;
  res.type('html').send(html);
}

/** 托管应用请求处理（已过门禁与限流；sub 为 /app/<id>/ 之后的路径） */
export function serveHtmlApp(req: Request, res: Response, app: AppRow, sub: string, noChrome = false): void {
  if (app.kind === 'package') {
    res
      .status(503)
      .type('html')
      .send(
        '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;display:grid;place-items:center;min-height:80vh">' +
          '<div style="text-align:center"><h2>该应用等待运行时支持</h2><p style="color:#888">Python 运行时将在 M4（生态）版本启用。</p></div>',
      );
    return;
  }

  const rel = (sub || 'index.html').replace(/^\/+/, '');
  const root = appSiteDir(app.id);
  const abs = path.resolve(root, rel);
  // 越界判断必须含路径分隔符语义（relative 非 ../ 开头且非绝对），
  // 裸 startsWith(root) 会被 "..%2F<兄弟目录>" 形式绕过（跨用户读文件，已实测）
  const relCheck = path.relative(root, abs);
  if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    res.status(400).type('html').send('Bad Path');
    return;
  }

  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    const ext = path.extname(abs).toLowerCase();
    res.type(MIME[ext] ?? 'application/octet-stream');
    if (ext === '.html' || ext === '.htm') {
      // 托管 HTML 同样注入统一页面元素（沙箱 raw 通道不注入——chrome 在外壳层）
      const html = fs.readFileSync(abs, 'utf8');
      res.send(noChrome ? html : injectChrome(html, app.id));
    } else {
      res.send(fs.readFileSync(abs));
    }
    return;
  }

  // SPA 类条目回退到 index.html
  const indexPath = path.join(appSiteDir(app.id), 'index.html');
  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, 'utf8');
    res.type('html').send(noChrome ? html : injectChrome(html, app.id));
    return;
  }
  res.status(404).type('html').send('Not Found');
}

/** 统一页面元素注入：右上角悬浮条（应用门户 / 个人中心 / 退出登录） */
export function injectChrome(html: string, appId: string): string {
  const tag = `<script src="/portal-chrome.js" data-aap-app="${encodeURIComponent(appId)}" defer></script>`;
  if (html.includes('/portal-chrome.js')) return html; // 幂等
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${tag}</body>`);
  return tag + html;
}

/** /portal-chrome.js 静态内容（小而自包含；会话态运行时拉取） */
export function portalChromeJs(): string {
  return `(function(){
  if (window.__aapChrome) return;
  window.__aapChrome = true;
  var style = document.createElement('style');
  style.textContent = [
    '#aap-chrome{position:fixed;top:10px;right:10px;z-index:2147483000;display:flex;gap:6px;',
    'align-items:center;background:rgba(255,255,255,.92);border:1px solid rgba(0,0,0,.08);',
    'border-radius:999px;padding:4px 8px;font:12px/1.6 system-ui,-apple-system,sans-serif;',
    'box-shadow:0 2px 8px rgba(0,0,0,.12)}',
    '#aap-chrome a{color:#1E5AA8;text-decoration:none;padding:2px 8px;border-radius:999px;white-space:nowrap}',
    '#aap-chrome a:hover{background:rgba(30,90,168,.1)}',
    '#aap-chrome .aap-user{color:#666;padding:0 4px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '@media (max-width:520px){#aap-chrome .aap-user{display:none}}'
  ].join('');
  document.head.appendChild(style);
  var bar = document.createElement('div');
  bar.id = 'aap-chrome';
  var back = encodeURIComponent(location.pathname + location.search);
  bar.innerHTML =
    '<a href="/">应用门户</a>' +
    '<a href="/account">个人中心</a>' +
    '<span class="aap-user" id="aap-chrome-user"></span>' +
    '<a href="/api/auth/logout?next=' + back + '" id="aap-chrome-logout" style="display:none">退出登录</a>';
  document.body.appendChild(bar);
  fetch('/api/auth/me', { credentials: 'include' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (me) {
      if (me && me.user && me.authState === 'full') {
        document.getElementById('aap-chrome-user').textContent = me.user.name;
        document.getElementById('aap-chrome-logout').style.display = '';
      } else {
        var lo = document.getElementById('aap-chrome-logout');
        if (lo) lo.remove();
      }
    })
    .catch(function () {});
})();`;
}

