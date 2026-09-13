/**
 * 管理端应用 CRUD（B4/E1）：保存即生效（registry 直读 DB）。
 * 安全校验：upstream 仅允许 localhost/内网地址（PRD 非功能需求），
 * 可用 APP_ALLOW_PUBLIC_UPSTREAM 显式放开（高级项）。
 */
import express, { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { apps } from '../db/schema.js';
import { HttpError, h } from '../lib/httpError.js';
import { requireAdmin } from '../lib/auth.js';
import { isSlug, listApps, findApp, getAcl, setAcl } from '../gateway/registry.js';
import { writeHtmlApp, storePackageFiles, validateManifest, appSiteDir } from '../gateway/staticApp.js';
import { encryptSecret } from '../lib/cryptoSecrets.js';
import { getSettingBool } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { probeAll } from '../gateway/health.js';

export const adminAppsRouter = Router();

adminAppsRouter.use('/admin/apps', requireAdmin);

interface AppPayload {
  id?: string;
  name?: string;
  description?: string;
  icon?: string;
  category?: string;
  visibility?: string;
  passUser?: boolean;
  upstream?: string;
  urlSecret?: string;
  enabled?: boolean;
  sort?: number;
  kind?: string;
  allowedGroupIds?: number[];
  allowedUserIds?: number[];
}

const VISIBILITIES = new Set(['public', 'login', 'restricted', 'private']);

/** 内网/本机地址校验（字面量；DNS 主机名可用高级设置放开） */
export function isInternalUpstream(hostname: string): boolean {
  if (getSettingBool('APP_ALLOW_PUBLIC_UPSTREAM', false)) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.lan')) return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  // IPv6 私有 fc00::/7
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('[fc') || h.startsWith('[fd')) return true;
  return false;
}

function parseUpstream(upstream: string): URL {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    throw new HttpError(400, 'INVALID_UPSTREAM', '上游地址不是合法 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'INVALID_UPSTREAM', '上游协议必须是 http/https');
  }
  if (!isInternalUpstream(url.hostname)) {
    throw new HttpError(400, 'UPSTREAM_NOT_INTERNAL', '上游仅允许本机/内网地址（可在高级设置中放开）');
  }
  return url;
}

adminAppsRouter.get(
  '/admin/apps',
  h(async (_req, res) => {
    res.json({
      apps: listApps().map((a) => {
        const acl = getAcl(a.id);
        return {
          id: a.id,
          name: a.name,
          description: a.description,
          icon: a.icon,
          category: a.category,
          visibility: a.visibility,
          passUser: a.passUser,
          upstream: a.upstream,
          kind: a.kind,
          ownerUserId: a.ownerUserId,
          hasUrlSecret: Boolean(a.urlSecretEnc),
          enabled: a.enabled,
          sort: a.sort,
          healthState: a.healthState,
          lastProbeAt: a.lastProbeAt,
          allowGroupIds: acl.allowGroupIds,
          allowUserIds: acl.allowUserIds,
        };
      }),
    });
  }),
);

adminAppsRouter.post(
  '/admin/apps',
  h(async (req, res) => {
    const body = (req.body ?? {}) as AppPayload;
    const id = String(body.id ?? '').trim();
    if (!isSlug(id)) throw new HttpError(400, 'INVALID_ID', '应用 ID 需为小写字母/数字/连字符（字母或数字开头）');
    if (findApp(id)) throw new HttpError(409, 'APP_EXISTS', '应用 ID 已存在');
    if (!body.name?.trim()) throw new HttpError(400, 'INVALID_NAME', '请填写应用名称');
    const kind = (body.kind as string) ?? 'upstream';
    if (kind === 'upstream') {
      if (!body.upstream) throw new HttpError(400, 'INVALID_UPSTREAM', '请填写上游地址');
      parseUpstream(body.upstream);
    }
    if (body.visibility && !VISIBILITIES.has(body.visibility)) {
      throw new HttpError(400, 'INVALID_VISIBILITY', '访问策略必须是 public/login/member');
    }

    const now = Date.now();
    getDb()
      .insert(apps)
      .values({
        id,
        name: body.name.trim(),
        description: body.description?.trim() ?? '',
        icon: body.icon ?? null,
        category: body.category?.trim() || '未分类',
        visibility: (body.visibility as string) ?? 'login',
        kind: (body.kind as string) ?? 'upstream',
        ownerUserId: req.user!.id,
        passUser: body.passUser ?? false,
        upstream: body.upstream ?? '',
        urlSecretEnc: body.urlSecret ? encryptSecret(body.urlSecret) : null,
        enabled: body.enabled ?? true,
        sort: body.sort ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    setAcl(id, { allowGroupIds: body.allowedGroupIds ?? [], allowUserIds: body.allowedUserIds ?? [] });
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'app.create', { id });
    void probeAll();
    res.json({ ok: true, id });
  }),
);

adminAppsRouter.put(
  '/admin/apps/:id',
  h(async (req, res) => {
    const id = String(req.params.id ?? '');
    const existing = findApp(id);
    if (!existing) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    const body = (req.body ?? {}) as AppPayload;

    const patch: Partial<typeof apps.$inferInsert> = { updatedAt: Date.now() };
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.description !== undefined) patch.description = body.description;
    if (body.icon !== undefined) patch.icon = body.icon;
    if (body.category !== undefined) patch.category = body.category;
    if (body.visibility !== undefined) {
      if (!VISIBILITIES.has(body.visibility)) throw new HttpError(400, 'INVALID_VISIBILITY', '访问策略必须是 public/login/member');
      patch.visibility = body.visibility;
    }
    if (body.passUser !== undefined) patch.passUser = body.passUser;
    if (body.upstream !== undefined) {
      parseUpstream(body.upstream);
      patch.upstream = body.upstream;
    }
    if (body.urlSecret !== undefined) {
      // 空串 = 清除；undefined = 保持不变
      patch.urlSecretEnc = body.urlSecret ? encryptSecret(body.urlSecret) : null;
    }
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.sort !== undefined) patch.sort = body.sort;

    getDb().update(apps).set(patch).where(eq(apps.id, id)).run();
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'app.update', { id });
    void probeAll();
    res.json({ ok: true });
  }),
);

adminAppsRouter.delete(
  '/admin/apps/:id',
  h(async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!findApp(id)) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    getDb().delete(apps).where(eq(apps.id, id)).run();
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'app.delete', { id });
    res.json({ ok: true });
  }),
);

adminAppsRouter.post(
  '/admin/apps/:id/test',
  h(async (req, res) => {
    const app = findApp(String(req.params.id ?? ''));
    if (!app) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const up = await fetch(app.upstream, { method: 'HEAD', redirect: 'manual', signal: ctrl.signal });
      up.body?.cancel();
      res.json({
        ok: up.status < 500,
        status: up.status,
        latencyMs: Date.now() - started,
      });
    } catch (err) {
      res.json({
        ok: false,
        error: err instanceof Error ? err.message : 'unknown',
        latencyMs: Date.now() - started,
      });
    } finally {
      clearTimeout(timer);
    }
  }),
);


// ---------- 简单 HTML 页接入（P4） ----------

adminAppsRouter.post(
  '/admin/apps/html',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { id?: string; name?: string; description?: string; html?: string; visibility?: string };
    const id = String(body.id ?? '').trim();
    if (!isSlug(id)) throw new HttpError(400, 'INVALID_ID', '应用 ID 需为小写字母/数字/连字符');
    if (findApp(id)) throw new HttpError(409, 'APP_EXISTS', '应用 ID 已存在');
    if (!body.name?.trim()) throw new HttpError(400, 'INVALID_NAME', '请填写应用名称');
    const html = String(body.html ?? '');
    if (!html.trim()) throw new HttpError(400, 'INVALID_HTML', '页面内容不能为空');
    if (html.length > 2 * 1024 * 1024) throw new HttpError(400, 'HTML_TOO_LARGE', '页面过大（≤2MB）');
    const visibility = body.visibility ?? 'restricted';
    if (!VISIBILITIES.has(visibility)) throw new HttpError(400, 'INVALID_VISIBILITY', '访问策略非法');

    writeHtmlApp(id, html);
    const now = Date.now();
    getDb()
      .insert(apps)
      .values({
        id,
        name: body.name.trim(),
        description: body.description?.trim() ?? '',
        category: '网页工具',
        visibility,
        kind: 'html',
        ownerUserId: req.user!.id,
        upstream: '',
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    setAcl(id, { allowGroupIds: [], allowUserIds: [] });
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'app.html.create', { id });
    res.json({ ok: true, id });
  }),
);

// ---------- .neon-aap 包上传（校验完整性 + manifest 提取；python 运行时 M4） ----------

adminAppsRouter.post(
  '/admin/apps/package',
  express.json({ limit: '15mb' }),
  h(async (req: express.Request, res: express.Response) => {
    const body = (req.body ?? {}) as { filename?: string; dataBase64?: string; visibility?: string; allowedGroupIds?: number[]; allowedUserIds?: number[]; passUser?: boolean; urlSecret?: string };
    if (!body.dataBase64) throw new HttpError(400, 'INVALID_PACKAGE', '缺少包文件内容');
    let zipBuf: Buffer;
    try {
      zipBuf = Buffer.from(body.dataBase64, 'base64');
    } catch {
      throw new HttpError(400, 'INVALID_PACKAGE', '包内容不是合法的 base64');
    }
    if (!body.filename?.toLowerCase().endsWith('.zip') && !body.filename?.toLowerCase().endsWith('.neon-aap')) {
      throw new HttpError(400, 'INVALID_PACKAGE_EXT', '包文件必须是 .zip / .neon-aap');
    }

    let manifest: ReturnType<typeof validateManifest>;
    try {
      const r = storePackageFiles('_upload_tmp', zipBuf);
      manifest = validateManifest(r.manifest);
      // 校验通过：挪到正式目录（同名包 = 版本更新，直接覆盖，符合「版本更新=重新审核」语义）
      const fs = await import('node:fs');
      const from = appSiteDir('_upload_tmp');
      const to = appSiteDir(manifest.name);
      fs.rmSync(to, { recursive: true, force: true });
      fs.renameSync(from, to);
    } catch (err) {
      const fs = await import('node:fs');
      fs.rmSync(appSiteDir('_upload_tmp'), { recursive: true, force: true });
      throw new HttpError(400, 'PACKAGE_INVALID', err instanceof Error ? err.message : '包校验失败');
    }

    if (findApp(manifest.name)) throw new HttpError(409, 'APP_EXISTS', '同名应用已存在（包版本更新请删除后重传，或直接覆盖文件目录）');
    const visibility = body.visibility ?? 'private';
    if (!VISIBILITIES.has(visibility)) throw new HttpError(400, 'INVALID_VISIBILITY', '访问策略非法');

    const now = Date.now();
    const isHtml = manifest.type === 'html';
    getDb()
      .insert(apps)
      .values({
        id: manifest.name,
        name: manifest.displayName,
        description: String((manifest as { description?: string }).description ?? ''),
        category: '用户提交',
        visibility,
        kind: isHtml ? 'html' : 'package',
        ownerUserId: req.user!.id,
        passUser: body.passUser ?? false,
        upstream: '',
        urlSecretEnc: body.urlSecret ? encryptSecret(body.urlSecret) : null,
        enabled: isHtml, // python 包等待运行时（M4），先不展示
        createdAt: now,
        updatedAt: now,
      })
      .run();
    setAcl(manifest.name, {
      allowGroupIds: body.allowedGroupIds ?? [],
      allowUserIds: body.allowedUserIds ?? [],
    });
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'app.package.create', {
      name: manifest.name,
      type: manifest.type,
      version: manifest.version,
      capabilities: manifest.capabilities,
      network: manifest.network,
    });
    res.json({
      ok: true,
      app: {
        id: manifest.name,
        displayName: manifest.displayName,
        version: manifest.version,
        type: manifest.type,
        entry: manifest.entry,
        runtime: manifest.runtime,
        capabilities: manifest.capabilities,
        network: manifest.network,
        route: manifest.route,
        enabled: isHtml,
        pendingRuntime: !isHtml,
      },
    });
  }),
);
