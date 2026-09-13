/**
 * 计费闭环（M3，D1–D4）：
 *  - D1 会员订阅：套餐（名称/分组/时长/价格）→ 开通加入分组（可见性随分组），到期自动降级（移出分组、保留数据）
 *  - D2 充值：额度订单按 TOPUP_TOKENS_PER_FEN 折算，确认到账即入账（grantTokens，三触发失效缓存）
 *  - D2a 结算：定时对账（缓存 vs 账本重算，吸收崩溃漂移）+ 到期降级扫描；欠费态 = 缓存余额低于预估，预检闸门直接拦截
 *  - D3 支付渠道：adapter 接口 + manual（人工确认）首发；微信/支付宝/Stripe 后续各写一个 adapter 即可接入
 * 账本与缓存的边界不变：账本 append-only，缓存可重算。
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { llmBalanceCache, llmLedger, llmRoutes, membershipPlans, topupOrders, userGroupMembers, users } from '../db/schema.js';
import { HttpError } from './httpError.js';
import { grantTokens, recomputeBalance } from './llm.js';
import { audit } from './audit.js';

export type OrderKind = 'tokens' | 'membership';
export type OrderStatus = 'pending' | 'paid' | 'cancelled';

// ---------- 套餐（D1） ----------

export interface PlanRow {
  id: number;
  name: string;
  groupId: number;
  durationDays: number;
  priceFen: number;
  tokenGrant: number;
  enabled: boolean;
}

export function listPlans(onlyEnabled = false): PlanRow[] {
  const rows = getDb()
    .select()
    .from(membershipPlans)
    .orderBy(sql`price_fen`)
    .all();
  return (onlyEnabled ? rows.filter((r) => r.enabled) : rows).map((r) => ({
    id: r.id,
    name: r.name,
    groupId: r.groupId,
    durationDays: r.durationDays,
    priceFen: r.priceFen,
    tokenGrant: r.tokenGrant,
    enabled: r.enabled,
  }));
}

export function createPlan(p: { name: string; groupId: number; durationDays: number; priceFen: number; tokenGrant?: number }): number {
  const info = getDb()
    .insert(membershipPlans)
    .values({
      name: p.name.trim().slice(0, 64),
      groupId: p.groupId,
      durationDays: Math.max(1, p.durationDays),
      priceFen: Math.max(0, p.priceFen),
      tokenGrant: Math.max(0, p.tokenGrant ?? 0),
      createdAt: Date.now(),
    })
    .run();
  return Number(info.lastInsertRowid);
}

export function updatePlan(id: number, patch: { name?: string; durationDays?: number; priceFen?: number; tokenGrant?: number; enabled?: boolean }): void {
  const set: Partial<typeof membershipPlans.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 64);
  if (patch.durationDays !== undefined) set.durationDays = Math.max(1, patch.durationDays);
  if (patch.priceFen !== undefined) set.priceFen = Math.max(0, patch.priceFen);
  if (patch.tokenGrant !== undefined) set.tokenGrant = Math.max(0, patch.tokenGrant);
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  getDb().update(membershipPlans).set(set).where(eq(membershipPlans.id, id)).run();
}

export function deletePlan(id: number): void {
  getDb().delete(membershipPlans).where(eq(membershipPlans.id, id)).run();
}

// ---------- 订单（D2/D3） ----------

export function newOrderId(): string {
  return `T${Date.now().toString(36)}${randomBytes(3).toString('hex')}`.toUpperCase();
}

export interface OrderRow {
  id: string;
  userId: number;
  kind: OrderKind;
  planId: number | null;
  tokens: number | null;
  priceFen: number;
  channel: string;
  status: OrderStatus;
  note: string | null;
  createdAt: number;
  paidAt: number | null;
}

export function listOrders(status: OrderStatus | 'all' = 'all', limit = 100): OrderRow[] {
  const base = getDb().select().from(topupOrders);
  const rows =
    status === 'all'
      ? base.orderBy(sql`id DESC`).limit(limit).all()
      : base.where(eq(topupOrders.status, status)).orderBy(sql`id DESC`).limit(limit).all();
  return rows as OrderRow[];
}

export function listUserOrders(userId: number, limit = 20): OrderRow[] {
  return getDb()
    .select()
    .from(topupOrders)
    .where(eq(topupOrders.userId, userId))
    .orderBy(sql`id DESC`)
    .limit(limit)
    .all() as OrderRow[];
}

export interface PaymentAdapter {
  readonly id: string;
  readonly name: string;
  /** 创建支付（manual：返回提示文案；真实渠道：返回支付链接/参数） */
  createPayment(order: OrderRow): { payHint: string; payUrl?: string };
}

/** 首发渠道：人工确认（管理员在运营面板确认到账） */
export const manualAdapter: PaymentAdapter = {
  id: 'manual',
  name: '人工确认',
  createPayment() {
    return { payHint: '请线下完成支付后联系管理员确认到账；确认后权益自动生效。' };
  },
};

export function paymentAdapters(): PaymentAdapter[] {
  return [manualAdapter];
}

/** 用户创建订单（tokens：按 TOPUP_TOKENS_PER_FEN 折算；membership：按套餐价格） */
export function createOrder(
  userId: number,
  kind: OrderKind,
  opts: { priceFen: number; tokens?: number; planId?: number; channel?: string },
): OrderRow {
  const id = newOrderId();
  getDb()
    .insert(topupOrders)
    .values({
      id,
      userId,
      kind,
      planId: opts.planId ?? null,
      tokens: opts.tokens ?? null,
      priceFen: Math.max(0, Math.round(opts.priceFen)),
      channel: opts.channel ?? 'manual',
      status: 'pending',
      createdAt: Date.now(),
    })
    .run();
  audit(`user:${userId}`, null, 'billing.order.create', { id, kind, priceFen: opts.priceFen });
  return listOrders('all', 1).find((o) => o.id === id)!;
}

/** 开通/续费会员：顺延到期 + 入组 + 赠送额度 */
export function activateMembership(userId: number, planId: number): string {
  const plan = getDb().select().from(membershipPlans).where(eq(membershipPlans.id, planId)).get();
  if (!plan) throw new HttpError(404, 'PLAN_NOT_FOUND', '套餐不存在');
  const me = getDb().select().from(users).where(eq(users.id, userId)).get();
  if (!me) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');

  // 到期续费从当前到期时间顺延；新购从现在起算
  const base = me.membershipExpiresAt && me.membershipPlanId === planId ? me.membershipExpiresAt : Date.now();
  const expiresAt = base + plan.durationDays * 86_400_000;
  getDb()
    .update(users)
    .set({ membershipPlanId: planId, membershipExpiresAt: expiresAt, plan: 'member' })
    .where(eq(users.id, userId))
    .run();
  // 加入套餐分组（可见性权益），重复加入幂等
  getDb()
    .insert(userGroupMembers)
    .values({ groupId: plan.groupId, userId, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
  if (plan.tokenGrant > 0) {
    grantTokens(userId, plan.tokenGrant, `功能订阅赠送（${plan.name}）`, 0);
  }
  return plan.name;
}

/** 确认到账（D3 manual 确认点；真实渠道 adapter 回调最终也走这里） */
export function confirmOrder(orderId: string, byUserId: number): OrderRow {
  const order = getDb().select().from(topupOrders).where(eq(topupOrders.id, orderId)).get() as OrderRow | undefined;
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', '订单不存在');
  if (order.status !== 'pending') throw new HttpError(400, 'ORDER_STATE', '订单已处理');
  getDb()
    .update(topupOrders)
    .set({ status: 'paid', paidAt: Date.now() })
    .where(eq(topupOrders.id, orderId))
    .run();

  if (order.kind === 'tokens' && order.tokens) {
    grantTokens(order.userId, order.tokens, `充值到账 ${orderId}`, byUserId);
  } else if (order.kind === 'membership' && order.planId) {
    activateMembership(order.userId, order.planId);
  }
  audit(`admin:${byUserId}`, null, 'billing.order.paid', { orderId, userId: order.userId });
  return getDb().select().from(topupOrders).where(eq(topupOrders.id, orderId)).get() as OrderRow;
}

export function cancelOrder(orderId: string, byUserId: number, byAdmin: boolean): void {
  const order = getDb().select().from(topupOrders).where(eq(topupOrders.id, orderId)).get() as OrderRow | undefined;
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', '订单不存在');
  if (!byAdmin && order.userId !== byUserId) throw new HttpError(403, 'FORBIDDEN', '只能取消自己的订单');
  if (order.status !== 'pending') throw new HttpError(400, 'ORDER_STATE', '订单已处理');
  getDb().update(topupOrders).set({ status: 'cancelled' }).where(eq(topupOrders.id, orderId)).run();
  audit(`user:${byUserId}`, null, 'billing.order.cancel', { orderId, byAdmin });
}

// ---------- 结算循环（D2a：对账 + 到期降级） ----------

const DAY_MS = 86_400_000;

/** 到期降级：会员到期 → 清订阅字段 + 移出套餐分组（保留数据，可见性随分组收回） */
export function downgradeExpired(now = Date.now()): number {
  const expired = getDb()
    .select()
    .from(users)
    .where(and(sql`membership_expires_at IS NOT NULL`, sql`membership_expires_at < ${now}`))
    .all();
  let n = 0;
  for (const u of expired) {
    const plan = u.membershipPlanId
      ? getDb().select().from(membershipPlans).where(eq(membershipPlans.id, u.membershipPlanId)).get()
      : null;
    getDb()
      .update(users)
      .set({ membershipPlanId: null, membershipExpiresAt: null, plan: 'free' })
      .where(eq(users.id, u.id))
      .run();
    if (plan) {
      getDb()
        .delete(userGroupMembers)
        .where(and(eq(userGroupMembers.groupId, plan.groupId), eq(userGroupMembers.userId, u.id)))
        .run();
    }
    audit(`user:${u.id}`, null, 'billing.subscription.expired', { planId: u.membershipPlanId });
    n++;
  }
  return n;
}

/** 对账：近期有流水/缓存缺失的用户重算余额（吸收崩溃漂移；打穿为负 = 欠费态被预检拦截） */
export function reconcileRecent(): number {
  const rows = getDb()
    .select({ userId: llmLedger.userId })
    .from(llmLedger)
    .where(and(sql`user_id IS NOT NULL`, gt(llmLedger.ts, Date.now() - 10 * 60_000)))
    .groupBy(llmLedger.userId)
    .all();
  let n = 0;
  for (const r of rows) {
    if (r.userId === null) continue;
    recomputeBalance(r.userId);
    n++;
  }
  return n;
}

let settleTimer: NodeJS.Timeout | null = null;
export function startBillingLoop(): void {
  if (settleTimer) return;
  const run = () => {
    try {
      const downgraded = downgradeExpired();
      const reconciled = reconcileRecent();
      if (downgraded || reconciled) console.log(`[billing] 降级 ${downgraded} 人，对账 ${reconciled} 人`);
    } catch (err) {
      console.error('[billing] 结算失败:', err);
    }
  };
  run();
  settleTimer = setInterval(run, 60_000);
  settleTimer.unref();
}
export function stopBillingLoop(): void {
  if (settleTimer) clearInterval(settleTimer);
  settleTimer = null;
}

// ---------- 运营统计（D4） ----------

export interface OpsStats {
  balanceTop: Array<{ userId: number; balance: number }>;
  spentTop: Array<{ userId: number; spent: number }>;
  appHot: Array<{ appId: string; calls: number; tokens: number }>;
  revenue30d: number;
  cost30d: number;
}

/** 运营面板：余额/消耗排行、应用热度、收入与成本（30 天窗口；成本按路由 costPer1k 折算） */
export function opsStats(): OpsStats {
  const db = getDb();
  const since = Date.now() - 30 * DAY_MS;

  const balanceTop = db
    .select({ userId: llmBalanceCache.userId, balance: llmBalanceCache.balance })
    .from(llmBalanceCache)
    .orderBy(sql`balance DESC`)
    .limit(10)
    .all();

  const spentTop = db
    .select({ userId: llmLedger.userId, spent: sql<number>`sum(-delta)` })
    .from(llmLedger)
    .where(and(eq(llmLedger.kind, 'usage'), sql`user_id IS NOT NULL`, gt(llmLedger.ts, since)))
    .groupBy(llmLedger.userId)
    .orderBy(sql`sum(-delta) DESC`)
    .limit(10)
    .all()
    .map((r) => ({ userId: r.userId ?? 0, spent: Number(r.spent) }));

  const appHot = db
    .select({
      appId: llmLedger.appId,
      calls: sql<number>`count(*)`,
      tokens: sql<number>`coalesce(sum(prompt_tokens + completion_tokens), 0)`,
    })
    .from(llmLedger)
    .where(and(eq(llmLedger.kind, 'usage'), gt(llmLedger.ts, since)))
    .groupBy(llmLedger.appId)
    .orderBy(sql`count(*) DESC`)
    .limit(10)
    .all()
    .map((r) => ({ appId: r.appId ?? '—', calls: Number(r.calls), tokens: Number(r.tokens) }));

  // 收入 = 用量按收入倍率折算的扣减；成本 = 用量按路由成本价折算
  const rev = db
    .select({ v: sql<number>`coalesce(sum(-delta), 0)` })
    .from(llmLedger)
    .where(and(eq(llmLedger.kind, 'usage'), gt(llmLedger.ts, since)))
    .get();
  const revenue30d = Number(rev?.v ?? 0);

  const routes = db.select().from(llmRoutes).all();
  let cost30d = 0;
  for (const r of routes) {
    const row = db
      .select({
        tokens: sql<number>`coalesce(sum(prompt_tokens + completion_tokens), 0)`,
      })
      .from(llmLedger)
      .where(and(eq(llmLedger.kind, 'usage'), eq(llmLedger.model, r.model), gt(llmLedger.ts, since)))
      .get();
    cost30d += Math.ceil((Number(row?.tokens ?? 0) * r.costPer1k) / 1000);
  }

  return { balanceTop, spentTop, appHot, revenue30d, cost30d };
}
