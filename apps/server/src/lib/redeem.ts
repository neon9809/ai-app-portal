/**
 * 卡券码（充值/会员兑换码）：
 *  - 管理员按批次生成（kind=tokens 指定额度 / kind=membership 绑定套餐；可设有效期）
 *  - 码格式 AAP-XXXX-XXXX-XXXX（去易混淆字符，80bit 随机空间，防爆破）
 *  - 兑换：原子置已用（防并发双花）→ tokens 入账（grant 三触发失效缓存）或会员开通
 *  - 可作废单枚；全事件审计；兑换接口按用户限速防穷举
 */
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { redeemCodes } from '../db/schema.js';
import { HttpError } from './httpError.js';
import { grantTokens } from './llm.js';
import { activateMembership } from './billing.js';
import { audit } from './audit.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去 I/L/O/0/1

export type RedeemKind = 'tokens' | 'membership';
export type RedeemStatus = 'unused' | 'used' | 'disabled';

function randomGroup(): string {
  const bytes = randomBytes(4);
  let out = '';
  for (let i = 0; i < 4; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

function newCode(): string {
  return `AAP-${randomGroup()}-${randomGroup()}-${randomGroup()}`;
}

/** 兑换输入归一化：容忍大小写/空格/连字符差异，支持带或不带 AAP 前缀的 12 位主体 */
export function normalizeCode(input: string): string {
  let clean = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.startsWith('AAP')) clean = clean.slice(3);
  if (clean.length !== 12) return input.toUpperCase().trim();
  return `AAP-${clean.slice(0, 4)}-${clean.slice(4, 8)}-${clean.slice(8, 12)}`;
}

export interface RedeemCodeRow {
  code: string;
  batchId: string;
  kind: RedeemKind;
  tokens: number | null;
  planId: number | null;
  status: RedeemStatus;
  note: string | null;
  expiresAt: number | null;
  usedBy: number | null;
  usedAt: number | null;
  createdAt: number;
}

export interface BatchSpec {
  kind: RedeemKind;
  count: number;
  tokens?: number | null;
  planId?: number | null;
  expiresInDays?: number | null;
  note?: string;
  byUserId: number;
}

/** 按批次生成卡券码（count ≤ 500/批） */
export function generateBatch(spec: BatchSpec): { batchId: string; codes: string[] } {
  const count = Math.min(500, Math.max(1, Math.trunc(spec.count) || 1));
  if (spec.kind === 'tokens' && (!spec.tokens || spec.tokens <= 0)) {
    throw new HttpError(400, 'INVALID_INPUT', '额度码必须指定大于 0 的 token 数量');
  }
  if (spec.kind === 'membership' && !spec.planId) {
    throw new HttpError(400, 'INVALID_INPUT', '会员码必须绑定套餐');
  }
  const db = getDb();
  const batchId = randomBytes(4).toString('hex');
  const expiresAt = spec.expiresInDays ? Date.now() + spec.expiresInDays * 86_400_000 : null;
  const codes: string[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    let code = newCode();
    // 碰撞重试（80bit 空间，实际不会发生，防御性处理）
    while (db.select({ c: redeemCodes.code }).from(redeemCodes).where(eq(redeemCodes.code, code)).get()) {
      code = newCode();
    }
    db.insert(redeemCodes)
      .values({
        code,
        batchId,
        kind: spec.kind,
        tokens: spec.kind === 'tokens' ? Math.max(1, Math.trunc(spec.tokens ?? 0)) : null,
        planId: spec.kind === 'membership' ? spec.planId! : null,
        status: 'unused',
        note: spec.note?.slice(0, 200) ?? null,
        expiresAt,
        createdBy: spec.byUserId,
        createdAt: now,
      })
      .run();
    codes.push(code);
  }
  audit(`admin:${spec.byUserId}`, null, 'redeem.batch.create', { batchId, kind: spec.kind, count });
  return { batchId, codes };
}

export function listCodes(opts: { batchId?: string; status?: RedeemStatus | 'all'; limit?: number }): RedeemCodeRow[] {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  let q = getDb().select().from(redeemCodes).$dynamic();
  if (opts.batchId) q = q.where(eq(redeemCodes.batchId, opts.batchId));
  if (opts.status && opts.status !== 'all') q = q.where(eq(redeemCodes.status, opts.status));
  return q.orderBy(sql`id DESC`).limit(limit).all() as RedeemCodeRow[];
}

export interface BatchSummary {
  batchId: string;
  kind: RedeemKind;
  total: number;
  used: number;
  tokens: number | null;
  planId: number | null;
  note: string | null;
  expiresAt: number | null;
  createdAt: number;
}

export function batchSummaries(): BatchSummary[] {
  return getDb()
    .select({
      batchId: redeemCodes.batchId,
      kind: redeemCodes.kind,
      total: sql<number>`count(*)`,
      used: sql<number>`sum(case when status = 'used' then 1 else 0 end)`,
      tokens: sql<number>`max(tokens)`,
      planId: sql<number>`max(plan_id)`,
      note: sql<string>`max(note)`,
      expiresAt: sql<number>`max(expires_at)`,
      createdAt: sql<number>`min(created_at)`,
    })
    .from(redeemCodes)
    .groupBy(redeemCodes.batchId)
    .orderBy(sql`min(created_at) DESC`)
    .limit(100)
    .all()
    .map((r) => ({
      batchId: r.batchId,
      kind: r.kind as RedeemKind,
      total: Number(r.total),
      used: Number(r.used),
      tokens: r.tokens == null ? null : Number(r.tokens),
      planId: r.planId == null ? null : Number(r.planId),
      note: r.note,
      expiresAt: r.expiresAt == null ? null : Number(r.expiresAt),
      createdAt: Number(r.createdAt),
    }));
}

export function disableCode(code: string): void {
  const res = getDb()
    .update(redeemCodes)
    .set({ status: 'disabled' })
    .where(and(eq(redeemCodes.code, code), eq(redeemCodes.status, 'unused')))
    .run();
  if (res.changes === 0) throw new HttpError(400, 'CODE_STATE', '码不存在或已被使用/作废');
}

export interface RedeemResult {
  kind: RedeemKind;
  tokens?: number;
  planName?: string;
}

/** 兑换：原子置已用 → tokens 入账（grant，三触发失效缓存）/ 会员开通 */
export function redeem(userId: number, rawCode: string, ip: string | null): RedeemResult {
  const code = normalizeCode(rawCode);
  const db = getDb();
  const row = db.select().from(redeemCodes).where(eq(redeemCodes.code, code)).get() as RedeemCodeRow | undefined;
  if (!row) throw new HttpError(404, 'CODE_NOT_FOUND', '兑换码不存在，请检查输入');
  if (row.status === 'used') throw new HttpError(400, 'CODE_USED', '该兑换码已被使用');
  if (row.status === 'disabled') throw new HttpError(400, 'CODE_DISABLED', '该兑换码已作废');
  if (row.expiresAt && row.expiresAt <= Date.now()) throw new HttpError(400, 'CODE_EXPIRED', '该兑换码已过期');

  // 原子消费：仅 unused 状态可置 used（防并发双花）
  const res = db
    .update(redeemCodes)
    .set({ status: 'used', usedBy: userId, usedAt: Date.now() })
    .where(and(eq(redeemCodes.code, code), eq(redeemCodes.status, 'unused')))
    .run();
  if (res.changes === 0) throw new HttpError(400, 'CODE_USED', '该兑换码已被使用');

  try {
    if (row.kind === 'tokens') {
      grantTokens(userId, row.tokens ?? 0, `兑换码 ${code}`, userId);
      audit(`user:${userId}`, ip, 'redeem.tokens', { code, tokens: row.tokens });
      return { kind: 'tokens', tokens: row.tokens ?? 0 };
    }
    // 会员码：开通/续费套餐（activateMembership 内含赠送额度入账）
    const planName = activateMembership(userId, row.planId!);
    audit(`user:${userId}`, ip, 'redeem.membership', { code, planId: row.planId });
    return { kind: 'membership', planName };
  } catch (err) {
    // 入账失败（如套餐被删）：回滚码状态，避免用户损失
    db.update(redeemCodes).set({ status: 'unused', usedBy: null, usedAt: null }).where(eq(redeemCodes.code, code)).run();
    throw err;
  }
}
