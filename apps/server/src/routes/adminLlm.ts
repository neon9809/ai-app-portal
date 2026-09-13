/**
 * LLM 网关管理 API（M2）：上游、模型路由、网关凭据、用户调额、用量查询。
 * 全部 requireAdmin；上游真实 key 只写不读（回显 hasKey）。
 */
import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { llmAppTokens, llmLedger, llmUpstreams, users } from '../db/schema.js';
import { HttpError, h } from '../lib/httpError.js';
import { requireAdmin } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import {
  createAppToken,
  createRoute,
  createUpstream,
  deleteRoute,
  deleteUpstream,
  grantTokens,
  listAppTokens,
  listRoutes,
  listUpstreams,
  recomputeBalance,
  revokeAppToken,
  updateUpstream,
} from '../lib/llm.js';

export const adminLlmRouter = Router();

adminLlmRouter.use('/admin/llm', requireAdmin);

// ---------- 上游 ----------

adminLlmRouter.get(
  '/admin/llm/upstreams',
  h(async (_req, res) => {
    res.json({ upstreams: listUpstreams() });
  }),
);

adminLlmRouter.post(
  '/admin/llm/upstreams',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { name?: string; baseUrl?: string; apiKey?: string };
    if (!body.name?.trim() || !body.baseUrl?.trim() || !body.apiKey?.trim()) {
      throw new HttpError(400, 'INVALID_INPUT', '名称、Base URL、API Key 均必填');
    }
    const id = createUpstream(body.name.trim(), body.baseUrl.trim(), body.apiKey.trim());
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'llm.upstream.create', { id, name: body.name });
    res.json({ ok: true, id });
  }),
);

adminLlmRouter.put(
  '/admin/llm/upstreams/:id',
  h(async (req, res) => {
    const id = Number(req.params.id);
    const body = (req.body ?? {}) as { name?: string; baseUrl?: string; apiKey?: string; enabled?: boolean };
    updateUpstream(id, body);
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'llm.upstream.update', { id });
    res.json({ ok: true });
  }),
);

adminLlmRouter.delete(
  '/admin/llm/upstreams/:id',
  h(async (req, res) => {
    deleteUpstream(Number(req.params.id));
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'llm.upstream.delete', { id: Number(req.params.id) });
    res.json({ ok: true });
  }),
);

// ---------- 模型路由 ----------

adminLlmRouter.get(
  '/admin/llm/routes',
  h(async (_req, res) => {
    const upstreams = new Map(listUpstreams().map((u) => [u.id, u.name]));
    res.json({
      routes: listRoutes().map((r) => ({ ...r, upstreamName: upstreams.get(r.upstreamId) ?? `#${r.upstreamId}` })),
    });
  }),
);

adminLlmRouter.post(
  '/admin/llm/routes',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { model?: string; upstreamId?: number; upstreamModel?: string; multiplier?: number; priority?: number; weight?: number };
    if (!body.model?.trim() || !body.upstreamId || !body.upstreamModel?.trim()) {
      throw new HttpError(400, 'INVALID_INPUT', 'model、upstreamId、upstreamModel 必填');
    }
    createRoute({
      model: body.model,
      upstreamId: body.upstreamId,
      upstreamModel: body.upstreamModel,
      multiplier: body.multiplier,
      priority: body.priority,
      weight: body.weight,
    });
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'llm.route.create', { model: body.model });
    res.json({ ok: true });
  }),
);

adminLlmRouter.delete(
  '/admin/llm/routes/:id',
  h(async (req, res) => {
    deleteRoute(Number(req.params.id));
    res.json({ ok: true });
  }),
);

// ---------- 网关凭据 ----------

adminLlmRouter.get(
  '/admin/llm/tokens',
  h(async (_req, res) => {
    res.json({
      tokens: listAppTokens().map((t) => ({
        id: t.id,
        appId: t.appId,
        name: t.name,
        enabled: t.enabled,
        perMinuteLimit: t.perMinuteLimit,
        createdAt: new Date(t.createdAt).toISOString(),
        lastUsedAt: t.lastUsedAt ? new Date(t.lastUsedAt).toISOString() : null,
      })),
    });
  }),
);

adminLlmRouter.post(
  '/admin/llm/tokens',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { appId?: string; name?: string; perMinuteLimit?: number | null };
    const appId = String(body.appId ?? '').trim();
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(appId)) {
      throw new HttpError(400, 'INVALID_APP_ID', '应用标识不合法');
    }
    const token = createAppToken(appId.toLowerCase(), String(body.name ?? ''), body.perMinuteLimit ?? null);
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'llm.token.create', { appId });
    res.json({ ok: true, token }); // 明文仅此一次
  }),
);

adminLlmRouter.delete(
  '/admin/llm/tokens/:id',
  h(async (req, res) => {
    revokeAppToken(Number(req.params.id));
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'llm.token.revoke', { id: Number(req.params.id) });
    res.json({ ok: true });
  }),
);

// ---------- 用户调额与用量 ----------

adminLlmRouter.post(
  '/admin/llm/adjust',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { userId?: number; delta?: number; note?: string };
    const userId = Number(body.userId);
    const delta = Math.trunc(Number(body.delta));
    if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(delta) || delta === 0) {
      throw new HttpError(400, 'INVALID_INPUT', 'userId 与非零整数 delta 必填');
    }
    if (!getDb().select({ id: users.id }).from(users).where(eq(users.id, userId)).get()) {
      throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    }
    grantTokens(userId, delta, String(body.note ?? '').slice(0, 200) || (delta > 0 ? '管理员发放' : '管理员调减'), req.user!.id);
    res.json({ ok: true, balance: recomputeBalance(userId) });
  }),
);

adminLlmRouter.get(
  '/admin/llm/usage',
  h(async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
    const rows = getDb()
      .select()
      .from(llmLedger)
      .orderBy(sql`id DESC`)
      .limit(limit)
      .all();
    res.json({
      rows: rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        kind: r.kind,
        userId: r.userId,
        appId: r.appId,
        model: r.model,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        delta: r.delta,
        latencyMs: r.latencyMs,
        status: r.status,
      })),
    });
  }),
);
