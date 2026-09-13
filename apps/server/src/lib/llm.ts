/**
 * LLM 网关核心（C1–C6）。
 * C/D 边界铁律（PRD）：账本只有一份（llm_ledger，append-only 只记不判）；
 * 余额只有一处（llm_balance_cache，读流水重算）。C 是请求路径上的记录者与
 * 预检者，结算（M3 D2a）在请求路径外异步校正，打穿 → 欠费态 + 失效缓存。
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { llmAppTokens, llmBalanceCache, llmLedger, llmRoutes, llmUpstreams } from '../db/schema.js';
import { decryptSecret, encryptSecret } from './cryptoSecrets.js';
import { HttpError } from './httpError.js';
import { getSettingInt } from './settings.js';

// ---------- 网关凭据（C2） ----------

/** 应用凭据默认限流（请求/分） */
export function llmPerMinuteDefault(): number {
  return getSettingInt('RATE_LLM_PER_MIN', 60) || 60;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface AppTokenRow {
  id: number;
  tokenHash: string;
  appId: string;
  name: string;
  enabled: boolean;
  perMinuteLimit: number | null;
  auto: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

export function createAppToken(
  appId: string,
  name: string,
  perMinuteLimit: number | null,
  opts?: { auto?: boolean },
): string {
  const token = `aapk_${randomBytes(24).toString('base64url')}`;
  const auto = opts?.auto === true;
  getDb()
    .insert(llmAppTokens)
    .values({
      tokenHash: hashToken(token),
      appId,
      name: name.slice(0, 64),
      perMinuteLimit,
      auto,
      // 自动签发的凭据：明文加密保管，供运行时（M4 沙箱）按 appId 注入，不再人工下发
      tokenEnc: auto ? encryptSecret(token) : null,
      createdAt: Date.now(),
    })
    .run();
  return token;
}

/** 已为应用自动签发的网关凭据（解密明文）；无则 null。M4 运行时启动注入用 */
export function getAppLlmProvision(appId: string): { token: string; perMinuteLimit: number | null } | null {
  const row = getDb()
    .select()
    .from(llmAppTokens)
    .where(and(eq(llmAppTokens.appId, appId), eq(llmAppTokens.auto, true), eq(llmAppTokens.enabled, true)))
    .get();
  if (!row?.tokenEnc) return null;
  try {
    return { token: decryptSecret(row.tokenEnc), perMinuteLimit: row.perMinuteLimit };
  } catch {
    return null;
  }
}

/** manifest 声明 llm 能力的包：确保存在自动签发凭据（幂等；重复上传复用） */
export function ensureAutoProvisionedToken(appId: string): void {
  const existing = getDb()
    .select()
    .from(llmAppTokens)
    .where(and(eq(llmAppTokens.appId, appId), eq(llmAppTokens.auto, true)))
    .get();
  if (existing && existing.enabled) return;
  createAppToken(appId, '自动签发（manifest llm）', null, { auto: true });
}

/** Bearer token → 凭据行；未命中/已吊销 → null */
export function resolveAppToken(bearer: string | undefined | null): AppTokenRow | null {
  if (!bearer) return null;
  const row = getDb()
    .select()
    .from(llmAppTokens)
    .where(eq(llmAppTokens.tokenHash, hashToken(bearer)))
    .get();
  if (!row || !row.enabled) return null;
  return row;
}

export function listAppTokens(): Array<AppTokenRow & { id: number }> {
  return getDb().select().from(llmAppTokens).orderBy(sql`id DESC`).all();
}

export function revokeAppToken(id: number): void {
  getDb().delete(llmAppTokens).where(eq(llmAppTokens.id, id)).run();
}

// ---------- 上游与模型目录（C3） ----------

export interface UpstreamRow {
  id: number;
  name: string;
  baseUrl: string;
  enabled: boolean;
  createdAt: number;
}

export function createUpstream(name: string, baseUrl: string, apiKey: string): number {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new HttpError(400, 'INVALID_BASE_URL', '上游 Base URL 不合法');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'INVALID_BASE_URL', '上游协议必须是 http/https');
  }
  const info = getDb()
    .insert(llmUpstreams)
    .values({ name, baseUrl, apiKeyEnc: encryptSecret(apiKey), createdAt: Date.now() })
    .run();
  return Number(info.lastInsertRowid);
}

export function listUpstreams(): Array<UpstreamRow & { hasKey: boolean }> {
  return getDb()
    .select()
    .from(llmUpstreams)
    .all()
    .map((u) => ({ id: u.id, name: u.name, baseUrl: u.baseUrl, enabled: u.enabled, createdAt: u.createdAt, hasKey: Boolean(u.apiKeyEnc) }));
}

export function updateUpstream(id: number, patch: { name?: string; baseUrl?: string; apiKey?: string; enabled?: boolean }): void {
  const set: Partial<typeof llmUpstreams.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
  if (patch.apiKey) set.apiKeyEnc = encryptSecret(patch.apiKey);
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  getDb().update(llmUpstreams).set(set).where(eq(llmUpstreams.id, id)).run();
}

export function deleteUpstream(id: number): void {
  getDb().delete(llmUpstreams).where(eq(llmUpstreams.id, id)).run();
}

function upstreamApiKey(upstreamId: number): string {
  const row = getDb().select().from(llmUpstreams).where(eq(llmUpstreams.id, upstreamId)).get();
  if (!row) throw new HttpError(502, 'UPSTREAM_GONE', '上游已删除');
  return decryptSecret(row.apiKeyEnc);
}

export interface RouteRow {
  id: number;
  model: string;
  upstreamId: number;
  upstreamModel: string;
  multiplier: number;
  priority: number;
  weight: number;
  enabled: boolean;
}

export function listRoutes(): RouteRow[] {
  return getDb().select().from(llmRoutes).all();
}

export function createRoute(r: { model: string; upstreamId: number; upstreamModel: string; multiplier?: number; priority?: number; weight?: number }): void {
  getDb()
    .insert(llmRoutes)
    .values({
      model: r.model.trim(),
      upstreamId: r.upstreamId,
      upstreamModel: r.upstreamModel.trim(),
      multiplier: r.multiplier ?? 100,
      priority: r.priority ?? 100,
      weight: r.weight ?? 100,
      createdAt: Date.now(),
    })
    .run();
}

export function deleteRoute(id: number): void {
  getDb().delete(llmRoutes).where(eq(llmRoutes.id, id)).run();
}

/** 聚合模型目录（C1 /v1/models 数据源） */
export function modelCatalog(): string[] {
  return [
    ...new Set(
      getDb()
        .select({ m: llmRoutes.model })
        .from(llmRoutes)
        .where(eq(llmRoutes.enabled, true))
        .all()
        .map((r) => r.m),
    ),
  ].sort();
}

/** 按模型解析 failover 候选：priority 升序，同优先级按 weight 加权随机 */
export function resolveRouteCandidates(model: string): Array<{ upstreamId: number; upstreamModel: string; multiplier: number; upstreamBaseUrl: string; apiKey: string }> {
  const rows = getDb()
    .select({
      id: llmRoutes.id,
      model: llmRoutes.model,
      upstreamId: llmRoutes.upstreamId,
      upstreamModel: llmRoutes.upstreamModel,
      multiplier: llmRoutes.multiplier,
      priority: llmRoutes.priority,
      weight: llmRoutes.weight,
      baseUrl: llmUpstreams.baseUrl,
      upstreamEnabled: llmUpstreams.enabled,
    })
    .from(llmRoutes)
    .innerJoin(llmUpstreams, eq(llmRoutes.upstreamId, llmUpstreams.id))
    .where(and(eq(llmRoutes.model, model), eq(llmRoutes.enabled, true)))
    .all();

  const live = rows.filter((r) => r.upstreamEnabled);
  if (live.length === 0) return [];

  const byPriority = new Map<number, typeof live>();
  for (const r of live) {
    const list = byPriority.get(r.priority) ?? [];
    list.push(r);
    byPriority.set(r.priority, list);
  }
  const candidates: Array<{ upstreamId: number; upstreamModel: string; multiplier: number; upstreamBaseUrl: string; apiKey: string }> = [];
  for (const priority of [...byPriority.keys()].sort((a, b) => a - b)) {
    const list = byPriority.get(priority)!;
    // 同优先级：weight 加权随机抽一个作为该层代表（简单加权轮换语义）
    const total = list.reduce((acc, r) => acc + Math.max(1, r.weight), 0);
    let pick = Math.random() * total;
    let chosen = list[0]!;
    for (const r of list) {
      pick -= Math.max(1, r.weight);
      if (pick <= 0) {
        chosen = r;
        break;
      }
    }
    candidates.push({
      upstreamId: chosen.upstreamId,
      upstreamModel: chosen.upstreamModel,
      multiplier: chosen.multiplier,
      upstreamBaseUrl: chosen.baseUrl,
      apiKey: upstreamApiKey(chosen.upstreamId),
    });
  }
  return candidates;
}

// ---------- 计量与预检（C5/C6） ----------

/** 余额缓存读数（无行 = 未初始化，由结算重算） */
export function cachedBalance(userId: number): number | null {
  const row = getDb().select().from(llmBalanceCache).where(eq(llmBalanceCache.userId, userId)).get();
  return row ? row.balance : null;
}

/** 从账本重算余额并写缓存（结算语义：读流水算余额；供事件失效与定时校正调用） */
export function recomputeBalance(userId: number): number {
  const row = getDb()
    .select({ sum: sql<number>`coalesce(sum(delta), 0)` })
    .from(llmLedger)
    .where(eq(llmLedger.userId, userId))
    .get();
  const balance = Number(row?.sum ?? 0);
  getDb()
    .insert(llmBalanceCache)
    .values({ userId, balance, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: llmBalanceCache.userId, set: { balance, updatedAt: Date.now() } })
    .run();
  return balance;
}

/** 账本追加（usage/grant/adjust 全走这里；append-only） */
export interface LedgerAppend {
  kind: 'usage' | 'grant' | 'adjust';
  delta: number;
  userId?: number | null;
  appId?: string | null;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  latencyMs?: number | null;
  status?: 'ok' | 'error';
  requestId?: string | null;
  note?: string | null;
}

export function appendLedger(e: LedgerAppend): number {
  const info = getDb()
    .insert(llmLedger)
    .values({
      ts: Date.now(),
      userId: e.userId ?? null,
      appId: e.appId ?? null,
      kind: e.kind,
      model: e.model ?? null,
      promptTokens: e.promptTokens ?? null,
      completionTokens: e.completionTokens ?? null,
      delta: Math.round(e.delta),
      latencyMs: e.latencyMs ?? null,
      status: e.status ?? 'ok',
      requestId: e.requestId ?? null,
      note: e.note ?? null,
    })
    .run();
  return Number(info.lastInsertRowid);
}

/** 管理员调额/发放（写账本 + 失效缓存——缓存同步三触发之一） */
export function grantTokens(userId: number, delta: number, note: string, byUserId: number): number {
  const id = appendLedger({ kind: delta >= 0 ? 'grant' : 'adjust', delta, userId, note, status: 'ok' });
  recomputeBalance(userId);
  auditGrant(userId, delta, note, byUserId);
  return id;
}

import { audit } from './audit.js';
function auditGrant(userId: number, delta: number, note: string, by: number): void {
  audit(`admin:${by}`, null, 'llm.balance.adjust', { userId, delta, note });
}

/** 预检闸门（C6）：原子递减预估成本；余额不足 → 402，请求不出网关。 */
export function precheck(userId: number | null, estimatedCost: number): void {
  if (userId === null) return; // 无用户归因 → 仅计量不拦截（M3 应用级配额再扩展）
  const db = getDb();
  const row = db.select().from(llmBalanceCache).where(eq(llmBalanceCache.userId, userId)).get();
  if (!row) {
    // 缓存未初始化：先按流水重算再判（避免首请求误拒）
    const balance = recomputeBalance(userId);
    if (balance < estimatedCost) throw insufficient(balance);
    return;
  }
  // 原子条件递减：balance >= est 才扣
  const res = db
    .update(llmBalanceCache)
    .set({ balance: sql`balance - ${estimatedCost}`, updatedAt: Date.now() })
    .where(and(eq(llmBalanceCache.userId, userId), sql`balance >= ${estimatedCost}`))
    .run();
  if (res.changes === 0) {
    const balance = row.balance;
    throw insufficient(balance);
  }
}

function insufficient(balance: number): HttpError {
  return new HttpError(402, 'INSUFFICIENT_BALANCE', '额度不足，请充值或联系管理员', {
    balance,
  });
}

/** 事后校正：实际扣费与预估的差值补回/补扣（不动账本——账本只记实际用量） */
export function settleEstimate(userId: number | null, estimatedCost: number, actualCost: number): void {
  if (userId === null) return;
  const diff = estimatedCost - actualCost;
  if (diff === 0) return;
  getDb()
    .update(llmBalanceCache)
    .set({ balance: sql`balance + ${diff}`, updatedAt: Date.now() })
    .where(eq(llmBalanceCache.userId, userId))
    .run();
}

/** 事件总线：缓存失效三触发（扣款欠费/充值到账/手动调额）统一走这里 */
type BalanceListener = (userId: number) => void;
const listeners = new Set<BalanceListener>();
export function onBalanceInvalidate(fn: BalanceListener): void {
  listeners.add(fn);
}
export function invalidateBalance(userId: number): void {
  recomputeBalance(userId);
  for (const fn of listeners) fn(userId);
}

/** 用量入账（请求完成后调用；实际用量落账本） */
export function recordUsage(e: {
  userId: number | null;
  appId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  multiplier: number;
  latencyMs: number;
  status: 'ok' | 'error';
  requestId: string;
}): number {
  const cost = Math.ceil(((e.promptTokens + e.completionTokens) * e.multiplier) / 100);
  const id = appendLedger({
    kind: 'usage',
    delta: -cost,
    userId: e.userId,
    appId: e.appId,
    model: e.model,
    promptTokens: e.promptTokens,
    completionTokens: e.completionTokens,
    latencyMs: e.latencyMs,
    status: e.status,
    requestId: e.requestId,
  });
  if (e.userId !== null) {
    // 实际扣费与缓存的校正走 settleEstimate；这里触发一次余额缓存事件（持久化视角刷新）
    const row = getDb().select().from(llmBalanceCache).where(eq(llmBalanceCache.userId, e.userId)).get();
    if (!row) recomputeBalance(e.userId);
  }
  return cost;
}
