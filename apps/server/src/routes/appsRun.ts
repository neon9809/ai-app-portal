/**
 * .neon-aap 运行与审核（M4，G3/G4/G5）：
 *  - POST /api/apps/:id/run            invoked 执行（requireAuth + 可见性门禁；运行记录入 app_runs + 审计）
 *  - GET  /api/apps/:id/meta           执行页元数据（入参 schema 等；匿名按可见性门禁可读公开应用）
 *  - POST /api/apps/submit             用户上传 .neon-aap（requireAuth；默认私有可见，归属=上传者；
 *                                      正式目录写入一律在归属校验之后，防止同名包清空他人应用）
 *  - POST /api/apps/:id/submit-review  提交审核（requireAuth；版本更新=重新审核）
 *  - GET  /api/apps/mine               我的应用（requireAuth，含审核状态）
 *  - 管理端：GET /api/admin/review/pending、approve / reject（驳回带理由）
 */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import express, { Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { appRuns, apps } from '../db/schema.js';
import { HttpError, h } from '../lib/httpError.js';
import { requireAdmin, requireAuth } from '../lib/auth.js';
import { canAccess } from '../gateway/registry.js';
import { appSiteDir } from '../gateway/staticApp.js';
import { runInvoked } from '../lib/sandbox.js';
import { ensureAutoProvisionedToken } from '../lib/llm.js';
import { config } from '../config/index.js';
import { storePackageFiles, validateManifest } from '../gateway/staticApp.js';
import { checkPackageSignature, type SignatureCheck, type SignatureObj } from '../lib/signing.js';
import { audit } from '../lib/audit.js';

export const appsRunRouter = Router();

function loadApp(id: string) {
  return getDb().select().from(apps).where(eq(apps.id, id)).get();
}

// ---------- 执行页元数据 ----------

appsRunRouter.get(
  '/apps/:id/meta',
  h(async (req, res) => {
    const app = loadApp(String(req.params.id));
    if (!app || !app.enabled || !canAccess(app, req.user ?? null)) {
      throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在或不可访问');
    }
    let inputSchema: unknown = null;
    if (app.inputSchema) {
      try {
        inputSchema = JSON.parse(app.inputSchema);
      } catch {
        inputSchema = null;
      }
    }
    res.json({
      id: app.id,
      name: app.name,
      description: app.description,
      kind: app.kind,
      runtimeMode: app.runtimeMode,
      inputSchema,
    });
  }),
);

// ---------- invoked 执行（G5） ----------

appsRunRouter.post(
  '/apps/:id/run',
  requireAuth,
  h(async (req, res) => {
    const app = loadApp(String(req.params.id));
    if (!app || !app.enabled || app.kind !== 'package') {
      throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在或不是可执行包');
    }
    if (!canAccess(app, req.user ?? null)) {
      throw new HttpError(403, 'FORBIDDEN', '无权访问该应用');
    }
    if (app.runtimeMode !== 'invoked') {
      throw new HttpError(400, 'NOT_INVOKED', '该应用为持久服务，请经 /app/<id>/ 访问');
    }
    let manifest: { entry?: string } = {};
    try {
      manifest = JSON.parse(app.manifestJson ?? '{}');
    } catch {
      /* ignore */
    }
    const entry = manifest.entry || 'mod.py';
    const input = (req.body ?? {}) as { input?: unknown };
    const userId = req.user!.id;

    const started = Date.now();
    // 平台地址取服务端真实监听端口（req.socket.localPort 是本机绑定事实，
    // 客户端不可控）。绝不能用请求 Host——那会注入沙箱的净网守卫放行面，
    // 也是 AAP_TOKEN 的外泄目标（渗透测试 P1-8 关联项）
    const platformPort = req.socket.localPort ?? config.port;
    const platformBase = `http://127.0.0.1:${platformPort}`;
    const result = await runInvoked(app.id, entry, input.input ?? {}, { userId, timeoutMs: 30_000, platformBase });

    getDb()
      .insert(appRuns)
      .values({
        appId: app.id,
        userId,
        ts: Date.now(),
        durationMs: result.durationMs,
        status: result.status,
        error: result.error ?? null,
        logs: result.logs ?? null,
      })
      .run();
    audit(`user:${userId}`, req.clientIp ?? null, 'app.run', {
      appId: app.id,
      status: result.status,
      durationMs: result.durationMs,
    });

    res.json({
      status: result.status,
      result: result.result ?? null,
      error: result.error ?? null,
      logs: result.logs ?? '',
      durationMs: result.durationMs,
    });
  }),
);

// ---------- 用户提交 .neon-aap（默认私有；版本更新=重新审核） ----------

appsRunRouter.post(
  '/apps/submit',
  requireAuth,
  // 大包体解析在鉴权之后（匿名 15MB JSON 解析 DoS 面收敛）
  express.json({ limit: '15mb' }),
  h(async (req, res) => {
    const body = (req.body ?? {}) as { filename?: string; dataBase64?: string };
    if (!body.dataBase64) throw new HttpError(400, 'INVALID_PACKAGE', '缺少包文件内容');
    let zipBuf: Buffer;
    try {
      zipBuf = Buffer.from(body.dataBase64, 'base64');
    } catch {
      throw new HttpError(400, 'INVALID_PACKAGE', '包内容不是合法的 base64');
    }

    // 解压与 manifest 校验只发生在临时目录；正式目录的任何写入/删除
    // 都必须等到归属校验之后（否则任何人可用同名包清空他人应用文件）。
    // 临时目录按请求唯一命名：并发提交共用固定目录会互踩。
    let rawManifest: Record<string, unknown>;
    let manifest: ReturnType<typeof validateManifest>;
    let signatureCheck: SignatureCheck;
    const tmpDir = `submit_tmp_${randomBytes(8).toString('hex')}`;
    try {
      const r = storePackageFiles(tmpDir, zipBuf);
      rawManifest = r.manifest;
      manifest = validateManifest(r.manifest);
      signatureCheck = checkPackageSignature(r.entries, r.signature as SignatureObj | null);
    } catch (err) {
      fs.rmSync(appSiteDir(tmpDir), { recursive: true, force: true });
      throw new HttpError(400, 'PACKAGE_INVALID', err instanceof Error ? err.message : '包校验失败');
    }
    if (signatureCheck.status === 'invalid') {
      // 签名与内容不符 = 包被篡改/损坏，硬拒（G4）
      fs.rmSync(appSiteDir(tmpDir), { recursive: true, force: true });
      throw new HttpError(400, 'PACKAGE_TAMPERED', `包签名校验失败：${signatureCheck.reason ?? '签名无效'}`);
    }
    // 官方签名（信任公钥命中）→ 免审：直接置 approved（G4）
    const reviewStatus = signatureCheck.status === 'verified' ? 'approved' : 'none';

    const now = Date.now();
    const existing = getDb().select().from(apps).where(eq(apps.id, manifest.name)).get();
    if (existing) {
      // 版本更新：仅归属者或管理员；视为重新审核（verified 免审直接 approved）
      const isOwner = existing.ownerUserId === req.user!.id;
      if (!isOwner && req.user!.role !== 'admin') {
        fs.rmSync(appSiteDir(tmpDir), { recursive: true, force: true });
        throw new HttpError(409, 'APP_EXISTS', '同名应用已存在');
      }
      const pending = signatureCheck.status !== 'verified';
      const to = appSiteDir(manifest.name);
      fs.rmSync(to, { recursive: true, force: true });
      fs.renameSync(appSiteDir(tmpDir), to);
      getDb()
        .update(apps)
        .set({
          description: String(rawManifest.description ?? existing.description),
          // 新包字段优先，旧 manifest 仅补足校验器不感知的字段（如 description）
          manifestJson: JSON.stringify({ ...(safeParse(existing.manifestJson) || {}), ...rawManifest, ...manifest }),
          signatureStatus: signatureCheck.status,
          reviewStatus: pending ? 'pending' : 'approved',
          // 审核门禁（P1-6）：非私有应用推未审新版先下线，待审通过恢复
          // （approve 置 enabled=true），杜绝未审代码对他人即时生效
          ...(pending && existing.visibility !== 'private' ? { enabled: false } : {}),
          submittedAt: now,
          updatedAt: now,
        })
        .where(eq(apps.id, manifest.name))
        .run();
      audit(`user:${req.user!.id}`, req.clientIp ?? null, 'app.package.update', {
        name: manifest.name,
        signature: signatureCheck.status,
      });
      res.json({ ok: true, id: manifest.name, review: pending ? 'pending' : 'approved' });
      return;
    }

    const to = appSiteDir(manifest.name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(appSiteDir(tmpDir), to);

    const isHtml = manifest.type === 'html';
    getDb()
      .insert(apps)
      .values({
        id: manifest.name,
        name: manifest.displayName,
        description: String(rawManifest.description ?? ''),
        category: '用户提交',
        visibility: 'private', // 用户自建默认仅自己可见（G3）
        kind: isHtml ? 'html' : 'package',
        ownerUserId: req.user!.id,
        passUser: manifest.capabilities.includes('llm'),
        upstream: '',
        manifestJson: JSON.stringify({ ...rawManifest, ...manifest }),
        signatureStatus: signatureCheck.status,
        runtimeMode: manifest.type === 'python' ? manifest.runtime : null,
        reviewStatus, // verified = 官方签名免审（G4）
        enabled: true, // 私有即可用（G4：上传 → 校验 → 私有可用）
        createdAt: now,
        updatedAt: now,
      })
      .run();
    ensureAutoProvisionedToken(manifest.name);
    audit(`user:${req.user!.id}`, req.clientIp ?? null, 'app.package.submit', {
      name: manifest.name,
      type: manifest.type,
      capabilities: manifest.capabilities,
      signature: signatureCheck.status,
    });
    res.json({ ok: true, id: manifest.name, review: reviewStatus });
  }),
);

function safeParse(v: string | null): Record<string, unknown> | null {
  if (!v) return null;
  try {
    return JSON.parse(v) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------- 我的应用（归属者视角） ----------

appsRunRouter.get(
  '/apps/mine',
  requireAuth,
  h(async (req, res) => {
    const uid = req.user!.id;
    const rows = getDb()
      .select()
      .from(apps)
      .where(and(eq(apps.ownerUserId, uid), eq(apps.kind, 'package')))
      .orderBy(sql`updated_at DESC`)
      .all();
    res.json({
      apps: rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        runtimeMode: r.runtimeMode,
        visibility: r.visibility,
        reviewStatus: r.reviewStatus,
        reviewNote: r.reviewNote,
        signatureStatus: r.signatureStatus,
        enabled: r.enabled,
        updatedAt: r.updatedAt,
      })),
    });
  }),
);

// ---------- 提交审核 / 取消审核 ----------

appsRunRouter.post(
  '/apps/:id/submit-review',
  requireAuth,
  h(async (req, res) => {
    const app = loadApp(String(req.params.id));
    if (!app) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    if (app.ownerUserId !== req.user!.id && req.user!.role !== 'admin') {
      throw new HttpError(403, 'FORBIDDEN', '只有归属者可以提交审核');
    }
    if (app.kind !== 'package') throw new HttpError(400, 'NOT_PACKAGE', '仅 .neon-aap 包需要审核');
    // 官方签名（信任公钥命中）→ 免审：直接 approved（G4）
    const auto = app.signatureStatus === 'verified';
    getDb()
      .update(apps)
      .set({
        reviewStatus: auto ? 'approved' : 'pending',
        reviewNote: auto ? '官方签名免审' : null,
        submittedAt: Date.now(),
        updatedAt: Date.now(),
      })
      .where(eq(apps.id, app.id))
      .run();
    audit(`user:${req.user!.id}`, req.clientIp ?? null, auto ? 'app.review.auto_approved' : 'app.review.submit', {
      appId: app.id,
    });
    res.json({ ok: true, review: auto ? 'approved' : 'pending' });
  }),
);

// ---------- 管理端审核 ----------

appsRunRouter.get(
  '/admin/review/pending',
  requireAdmin,
  h(async (_req, res) => {
    const rows = getDb()
      .select()
      .from(apps)
      .where(eq(apps.reviewStatus, 'pending'))
      .orderBy(sql`submitted_at DESC`)
      .all();
    res.json({
      pending: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        ownerUserId: r.ownerUserId,
        visibility: r.visibility,
        manifest: safeParse(r.manifestJson),
        submittedAt: r.submittedAt,
      })),
    });
  }),
);

appsRunRouter.post(
  '/admin/review/:id/approve',
  requireAdmin,
  h(async (req, res) => {
    const body = (req.body ?? {}) as { visibility?: string };
    const id = String(req.params.id);
    const app = loadApp(id);
    if (!app) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    const visibility = body.visibility ?? 'public';
    getDb()
      .update(apps)
      .set({ reviewStatus: 'approved', reviewNote: null, enabled: true, updatedAt: Date.now(), ...(body.visibility ? { visibility } : {}) })
      .where(eq(apps.id, id))
      .run();
    audit(`admin:${req.user!.id}`, req.clientIp ?? null, 'app.review.approved', { appId: id, visibility });
    res.json({ ok: true });
  }),
);

appsRunRouter.post(
  '/admin/review/:id/reject',
  requireAdmin,
  h(async (req, res) => {
    const body = (req.body ?? {}) as { note?: string };
    const id = String(req.params.id);
    const app = loadApp(id);
    if (!app) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在');
    getDb()
      .update(apps)
      .set({ reviewStatus: 'rejected', reviewNote: String(body.note ?? '').slice(0, 300), updatedAt: Date.now() })
      .where(eq(apps.id, id))
      .run();
    audit(`admin:${req.user!.id}`, req.clientIp ?? null, 'app.review.rejected', { appId: id, note: body.note });
    res.json({ ok: true });
  }),
);
