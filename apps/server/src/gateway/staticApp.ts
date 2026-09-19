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
  relaxDirForSandbox(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
}

/** 沙箱降权启用时（SANDBOX_UID），包目录须允许沙箱 uid 在其中创建 storage/ 与
 *  app.sqlite（runner 以沙箱 uid 自建这两者）。容器内仅 root 与 aap(10001) 两个
 *  uid，0777 的放宽面只在容器内部；未启用降权的部署保持默认 0755。 */
function relaxDirForSandbox(dir: string): void {
  if (!process.env.SANDBOX_UID) return;
  try {
    fs.chmodSync(dir, 0o777);
  } catch {
    /* 尽力而为：失败时降权沙箱将无法写入该包，运行报错可见 */
  }
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
  type ZipEntry = { entryName: string; isError: boolean; getData: () => Buffer; header?: { size?: number } };
  const AdmZip = req('adm-zip') as new (b: Buffer) => { getEntries(): ZipEntry[] };
  const zip = new AdmZip(zipBuffer);
  const dir = appSiteDir(appId);
  fs.mkdirSync(dir, { recursive: true });
  relaxDirForSandbox(dir);
  let files = 0;
  let manifest: Record<string, unknown> | null = null;
  let signature: Record<string, unknown> | null = null;
  const entries: Array<{ name: string; content: Buffer }> = [];
  // 解压放大防护（zip 炸弹）：15MB 包体可声明任意解压体积——条目数与累计解压
  // 字节双上限，超限整包拒绝（目录就地清理，调用方 catch 转 PACKAGE_INVALID）
  const MAX_ENTRIES = 2000;
  const MAX_UNCOMPRESSED = 100 * 1024 * 1024;
  let processed = 0;
  let uncompressed = 0;
  const rejectPackage = (reason: string): never => {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(reason);
  };
  for (const entry of zip.getEntries()) {
    if (entry.isError) continue;
    if (++processed > MAX_ENTRIES) rejectPackage('包内条目数超过上限（2000）');
    const name = entry.entryName.replace(/\\/g, '/');
    if (name.includes('..') || name.startsWith('/') || name.endsWith('/')) continue;
    const dest = path.join(dir, name);
    // 防压缩包路径逃逸：relative 结果必须是 dir 内部相对路径
    // （startsWith(dir) 缺路径分隔符，"x" 可匹配兄弟目录 "x-secret"，已实测绕过）
    const rel = path.relative(dir, dest);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    // header 声明值先拒一遍，避免为判超限而先完整解压超大条目（声明可伪造，
    // 解压后按实际字节数复核才是权威判定）
    const declared = Number(entry.header?.size ?? 0);
    if (declared > MAX_UNCOMPRESSED || uncompressed + declared > MAX_UNCOMPRESSED) {
      rejectPackage('包解压后总大小超过上限（100MB），疑似压缩炸弹');
    }
    const content = entry.getData();
    uncompressed += content.length;
    if (uncompressed > MAX_UNCOMPRESSED) {
      rejectPackage('包解压后总大小超过上限（100MB），疑似压缩炸弹');
    }
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

// ---------- manifest.env：应用环境变量 / 机密声明（G6） ----------

export interface ManifestEnvVar {
  /** true = 沙箱启动前必须已配置（invoked 执行 / persistent 拉起前强校验） */
  required: boolean;
  /** true = 机密：AES-256-GCM 加密落盘，接口永不回明文（只回配置状态与尾 4 位） */
  secret: boolean;
  description: string;
  /** 简单校验正则（保存配置时执行 test；不锚定，作者自行写 ^ $） */
  pattern: string | null;
  /** 未配置时的注入默认值（secret 不允许 default） */
  default: string | null;
}

/** 沙箱注入面保留名：平台托管（AAP_* / PORT / AAP_DB_PATH…）或宿主透传（代理 / Python 运行时），
 *  包声明即拒绝——否则可劫持 egress 代理（HTTP_PROXY）、身份归因（AAP_TOKEN）等平台机制 */
const RESERVED_ENV_NAMES = new Set(
  [
    'PORT',
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'PYTHONUNBUFFERED',
    'PYTHONPATH',
    'PYTHONHOME',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SANDBOX_UID',
    'SANDBOX_GID',
    'NODE_OPTIONS',
  ].map((k) => k.toUpperCase()),
);

export const MAX_ENV_VARS = 16;

/** 解析并校验 manifest.env 声明；支持两种写法：
 *  "NAME": "描述"（速记，required=true） 或 "NAME": { required, secret, description, pattern, default } */
export function parseEnvSpec(value: unknown): Record<string, ManifestEnvVar> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest.env 必须是对象');
  const raw = value as Record<string, unknown>;
  const names = Object.keys(raw);
  if (names.length > MAX_ENV_VARS) throw new Error(`manifest.env 最多声明 ${MAX_ENV_VARS} 个变量`);
  const out: Record<string, ManifestEnvVar> = {};
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error(`manifest.env 变量名非法: ${name}`);
    if (name.toUpperCase().startsWith('AAP_') || RESERVED_ENV_NAMES.has(name.toUpperCase())) {
      throw new Error(`manifest.env 变量名与平台保留名冲突: ${name}`);
    }
    const v = raw[name];
    let spec: ManifestEnvVar;
    if (typeof v === 'string') {
      spec = { required: true, secret: false, description: v, pattern: null, default: null };
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const secret = o.secret === true;
      const def = o.default != null ? String(o.default) : null;
      if (def != null && (def.length > 4096 || secret)) throw new Error(`manifest.env.${name} 的 default 非法（过长或机密变量不允许默认值）`);
      const pattern = o.pattern != null ? String(o.pattern) : null;
      if (pattern != null) {
        if (pattern.length > 200) throw new Error(`manifest.env.${name} 的 pattern 过长`);
        try {
          // eslint-disable-next-line no-new
          new RegExp(pattern);
        } catch {
          throw new Error(`manifest.env.${name} 的 pattern 不是合法正则`);
        }
      }
      spec = {
        required: o.required !== false,
        secret,
        description: String(o.description ?? '').slice(0, 200),
        pattern,
        default: def,
      };
    } else {
      throw new Error(`manifest.env.${name} 的声明必须是描述字符串或对象`);
    }
    out[name] = spec;
  }
  return out;
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
  env: Record<string, ManifestEnvVar>;
} {
  const name = String(m.name ?? '');
  const type = String(m.type ?? '');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('manifest.name 需为小写字母/数字/连字符');
  if (type !== 'html' && type !== 'python') throw new Error('manifest.type 必须是 html 或 python');
  const entry = String(m.entry ?? (type === 'html' ? 'index.html' : ''));
  if (type === 'python' && !entry) throw new Error('python 包必须声明 entry');
  // entry 越界即执行包目录外的任意 .py（第二轮渗透 NEW-1 实锤：跨包代码执行）——
  // 上传口拒绝；packageEntryPath 另有运行时兜底
  if (entry.includes('..') || path.isAbsolute(entry)) throw new Error('manifest.entry 不得包含相对路径段或绝对路径');
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
    env: parseEnvSpec(m.env),
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

/** raw 通道前缀：沙箱外壳内 iframe 加载 /app/<id>/raw/…（内容不经门户源直出）。
 *  必须锚定段边界（raw 或 raw/…）：/^raw\/?/ 会把 rawfoo 也当 raw 直出，
 *  既绕过外壳又误伤以 raw 开头的正常资源 */
const RAW_PREFIX_RE = /^raw(?:\/|$)/;

/** raw 通道响应的 CSP：sandbox 标志与外壳 iframe sandbox 对齐（刻意不含
 *  allow-same-origin）——受害者被诱导顶层直达 raw URL 时，包代码同样被关进
 *  opaque origin（读 /api 受 CORS 拦、写 /api 受 CSRF Origin(null) 拦、
 *  会话 cookie 不随 opaque origin 可用）。处理器内在全局通用 CSP 之后覆盖设置 */
export const RAW_SANDBOX_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock; object-src 'none'; base-uri 'none'";

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
  // raw 通道（noChrome）：顶层直达 raw URL 时包代码在门户源裸奔执行（P0）——
  // 输出前覆盖全局通用 CSP，用 sandbox 指令把顶层导航也关进 opaque origin
  if (noChrome) res.setHeader('Content-Security-Policy', RAW_SANDBOX_CSP);
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

