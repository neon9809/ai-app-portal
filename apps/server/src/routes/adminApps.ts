/**
 * 管理端应用 CRUD（B4/E1）：保存即生效（registry 直读 DB）。
 * 安全校验：upstream 仅允许 localhost/内网地址（PRD 非功能需求），
 * 可用 APP_ALLOW_PUBLIC_UPSTREAM 显式放开（高级项）。
 */
import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { apps, llmAppTokens } from '../db/schema.js';
import { HttpError, h } from '../lib/httpError.js';
import { requireAdmin } from '../lib/auth.js';
import { isSlug, idConflictsWithGatewayPrefix, listApps, findApp, getAcl, setAcl } from '../gateway/registry.js';
import { writeHtmlApp, storePackageFiles, validateManifest, appSiteDir } from '../gateway/staticApp.js';
import { checkPackageSignature, type SignatureCheck, type SignatureObj } from '../lib/signing.js';
import { ensureAutoProvisionedToken } from '../lib/llm.js';
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
  /** kind=html 编辑页面内容（PUT 时生效） */
  html?: string;
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
    if (idConflictsWithGatewayPrefix(id))
      throw new HttpError(400, 'INVALID_ID', '该应用 ID 与 FPK 统一网关入口路径冲突，请更换 ID');
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

adminAppsRouter.get(
  '/admin/apps/:id/html',
  h(async (req, res) => {
    const app = findApp(String(req.params.id ?? ''));
    if (!app) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    if (app.kind !== 'html') throw new HttpError(400, 'NOT_HTML', '仅门户托管的 HTML 应用可读取页面内容');
    const file = path.join(appSiteDir(app.id), 'index.html');
    if (!fs.existsSync(file)) throw new HttpError(404, 'NO_CONTENT', '该应用尚无页面文件');
    res.json({ html: fs.readFileSync(file, 'utf8') });
  }),
);

adminAppsRouter.put(
  '/admin/apps/:id',
  h(async (req, res) => {
    const id = String(req.params.id ?? '');
    const existing = findApp(id);
    if (!existing) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    const body = (req.body ?? {}) as AppPayload;

    // HTML 页面内容更新（保存即生效；仅 kind=html）
    if (body.html !== undefined) {
      if (existing.kind !== 'html') throw new HttpError(400, 'NOT_HTML', '仅门户托管的 HTML 应用可更新页面内容');
      const html = String(body.html);
      if (!html.trim()) throw new HttpError(400, 'INVALID_HTML', '页面内容不能为空');
      if (html.length > 2 * 1024 * 1024) throw new HttpError(400, 'HTML_TOO_LARGE', '页面过大（≤2MB）');
      writeHtmlApp(id, html);
      audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'app.html.update', { id, bytes: html.length });
    }

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
    // 网关能力闸以 apps 行为准（appLlmAllowed）：应用删除必须连带吊销全部
    // 网关凭据，否则残留凭据因「应用行已不存在」反而脱离能力闸（审计 F1 配套）
    getDb().delete(llmAppTokens).where(eq(llmAppTokens.appId, id)).run();
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'app.delete', { id });
    res.json({ ok: true });
  }),
);

adminAppsRouter.post(
  '/admin/apps/:id/test',
  h(async (req, res) => {
    const app = findApp(String(req.params.id ?? ''));
    if (!app) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    // 门户托管应用（html/package）没有独立上游，由门户自身直接服务
    if (app.kind !== 'upstream') {
      return res.json({ ok: true, status: 200, latencyMs: 0, note: '门户托管应用（无独立上游，由门户直接服务）' });
    }
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
    if (idConflictsWithGatewayPrefix(id))
      throw new HttpError(400, 'INVALID_ID', '该应用 ID 与 FPK 统一网关入口路径冲突，请更换 ID');
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

/** 上传前预解析：仅校验与提取 manifest/签名信息，不落正式目录、不建应用。
 *  供管理端选包后即时展示解析结果（临时目录用后即删）。 */
adminAppsRouter.post(
  '/admin/apps/package/preview',
  express.json({ limit: '15mb' }),
  h(async (req: express.Request, res: express.Response) => {
    const body = (req.body ?? {}) as { filename?: string; dataBase64?: string };
    if (!body.dataBase64) throw new HttpError(400, 'INVALID_PACKAGE', '缺少包文件内容');
    let zipBuf: Buffer;
    try {
      zipBuf = Buffer.from(body.dataBase64, 'base64');
    } catch {
      throw new HttpError(400, 'INVALID_PACKAGE', '包内容不是合法的 base64');
    }
    const tmpDir = `preview_tmp_${randomBytes(8).toString('hex')}`;
    try {
      const r = storePackageFiles(tmpDir, zipBuf);
      const manifest = validateManifest(r.manifest);
      const sig = checkPackageSignature(r.entries, r.signature as SignatureObj | null);
      const existing = findApp(manifest.name);
      res.json({
        id: manifest.name,
        displayName: manifest.displayName,
        version: manifest.version,
        type: manifest.type,
        runtime: manifest.type === 'python' ? manifest.runtime : null,
        capabilities: manifest.capabilities,
        network: manifest.network,
        env: Object.entries(manifest.env).map(([name, s]) => ({
          name,
          required: s.required,
          secret: s.secret,
          description: s.description,
        })),
        signature: sig.status,
        /** 同名应用已存在：接入将作为版本更新（需归属者或管理员） */
        exists: Boolean(existing),
        existingKind: existing?.kind ?? null,
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'PACKAGE_INVALID', err instanceof Error ? err.message : '包校验失败');
    } finally {
      fs.rmSync(appSiteDir(tmpDir), { recursive: true, force: true });
    }
  }),
);

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

    // 临时目录按请求唯一（并发上传互踩防御）；正式目录的覆盖必须等到
    // 签名校验与同名查重都通过之后（否则 409 时他人/自己的站点已被换掉）
    const tmpDir = `upload_tmp_${randomBytes(8).toString('hex')}`;
    let manifest: ReturnType<typeof validateManifest>;
    let signatureCheck: SignatureCheck;
    let rawManifest: Record<string, unknown> = {};
    try {
      const r = storePackageFiles(tmpDir, zipBuf);
      rawManifest = r.manifest;
      manifest = validateManifest(r.manifest);
      signatureCheck = checkPackageSignature(r.entries, r.signature as SignatureObj | null);
      if (signatureCheck.status === 'invalid') {
        throw new HttpError(400, 'PACKAGE_TAMPERED', `包签名校验失败：${signatureCheck.reason ?? '签名无效'}`);
      }
      if (findApp(manifest.name)) {
        throw new HttpError(409, 'APP_EXISTS', '同名应用已存在（包版本更新请删除后重传，或直接覆盖文件目录）');
      }
      // 校验与查重通过：挪到正式目录
      const from = appSiteDir(tmpDir);
      const to = appSiteDir(manifest.name);
      fs.rmSync(to, { recursive: true, force: true });
      fs.renameSync(from, to);
    } catch (err) {
      fs.rmSync(appSiteDir(tmpDir), { recursive: true, force: true });
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'PACKAGE_INVALID', err instanceof Error ? err.message : '包校验失败');
    }
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
        manifestJson: JSON.stringify({ ...rawManifest, ...manifest }),
        runtimeMode: isHtml ? null : manifest.runtime,
        signatureStatus: signatureCheck.status,
        // python 沙箱运行时已上线：管理员上传的包与用户提交同语义，上传即可用（默认私有）
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    setAcl(manifest.name, {
      allowGroupIds: body.allowedGroupIds ?? [],
      allowUserIds: body.allowedUserIds ?? [],
    });
    // 运行时凭据统一自动签发（幂等）：AAP_TOKEN 同时是 egress 出站凭据，非 llm 包也需要；
    // LLM 花费面由 appLlmAllowed 在 /v1 网关与 /api/aap/llm/chat 双侧按 manifest.capabilities 闸（审计 F1）
    ensureAutoProvisionedToken(manifest.name);
    const llmProvisioned = manifest.capabilities.includes('llm');
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'app.package.create', {
      name: manifest.name,
      type: manifest.type,
      version: manifest.version,
      capabilities: manifest.capabilities,
      network: manifest.network,
    });
    res.json({
      ok: true,
      llmProvisioned,
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
