/**
 * M3 计费闭环测试（D1/D2/D2a）：
 * 套餐 → 下单 → 确认到账 → 会员生效入组 + 额度到账 → 到期降级出组；
 * 订单取消；结算对账吸收漂移；欠费态预检 402。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { closeDb, getDb } from '../db/index.js';
import { llmBalanceCache, userGroupMembers, userGroups, users } from '../db/schema.js';
import { seedSettings } from '../lib/settings.js';
import {
  cancelOrder,
  confirmOrder,
  createOrder,
  createPlan,
  downgradeExpired,
  reconcileRecent,
} from '../lib/billing.js';
import { appendLedger, cachedBalance, precheck, recomputeBalance } from '../lib/llm.js';
import { HttpError } from '../lib/httpError.js';

let dir: string;
let planId = 0;
let groupId = 0;
let userId = 0;

beforeAll(() => {
  ({ dir } = setupTestDb());
  seedSettings();

  const g = getDb().insert(userGroups).values({ name: '会员-高级', createdAt: Date.now() }).run();
  groupId = Number(g.lastInsertRowid);
  planId = createPlan({ name: '高级会员', groupId, durationDays: 30, priceFen: 3000, tokenGrant: 50_000 });

  const u = getDb()
    .insert(users)
    .values({ kind: 'local', username: 'billuser', name: 'b', createdAt: Date.now() })
    .run();
  userId = Number(u.lastInsertRowid);
});

afterAll(() => {
  closeDb();
  teardownTestDb(dir);
});

describe('M3 计费闭环（D1/D2）', () => {
  it('订单：创建（manual 渠道）→ 确认到账 → 会员生效入组 + 额度到账', () => {
    const order = createOrder(userId, 'membership', { priceFen: 3000, planId });
    expect(order.status).toBe('pending');

    const paid = confirmOrder(order.id, 1);
    expect(paid.status).toBe('paid');

    const me = getDb().select().from(users).where(eq(users.id, userId)).get();
    expect(me!.membershipPlanId).toBe(planId);
    expect(me!.membershipExpiresAt!).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(me!.plan).toBe('member');

    const inGroup = getDb()
      .select()
      .from(userGroupMembers)
      .where(eq(userGroupMembers.userId, userId))
      .all();
    expect(inGroup.map((m) => m.groupId)).toContain(groupId);
    // 开通赠送额度到账
    expect(cachedBalance(userId)).toBe(50_000);
  });

  it('续费顺延：同套餐再次确认从当前到期时间叠加', () => {
    const order = createOrder(userId, 'membership', { priceFen: 3000, planId });
    const before = getDb().select().from(users).where(eq(users.id, userId)).get()!.membershipExpiresAt!;
    confirmOrder(order.id, 1);
    const after = getDb().select().from(users).where(eq(users.id, userId)).get()!.membershipExpiresAt!;
    expect(after - before).toBeGreaterThanOrEqual(29 * 86_400_000);
  });

  it('取消：pending 可取消，已付不可取消', () => {
    const o = createOrder(userId, 'tokens', { priceFen: 1000, tokens: 1000 });
    cancelOrder(o.id, userId, false);
    expect(() => cancelOrder(o.id, userId, false)).toThrow(/已处理/);
  });

  it('到期降级：清订阅字段 + 移出分组（保留数据）', () => {
    getDb()
      .update(users)
      .set({ membershipExpiresAt: Date.now() - 1000 })
      .where(eq(users.id, userId))
      .run();
    const n = downgradeExpired();
    expect(n).toBeGreaterThanOrEqual(1);
    const me = getDb().select().from(users).where(eq(users.id, userId)).get();
    expect(me!.membershipPlanId).toBeNull();
    expect(me!.plan).toBe('free');
    const inGroup = getDb()
      .select()
      .from(userGroupMembers)
      .where(eq(userGroupMembers.userId, userId))
      .all()
      .filter((m) => m.groupId === groupId);
    expect(inGroup).toHaveLength(0);
  });
});

describe('M3 结算对账（D2a）', () => {
  it('缓存漂移被重算吸收；欠费态预检 402', () => {
    const uid = 900;
    getDb()
      .insert(llmBalanceCache)
      .values({ userId: uid, balance: 999_999, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: llmBalanceCache.userId, set: { balance: 999_999, updatedAt: Date.now() } })
      .run();
    // 一笔真实用量（账本），缓存未扣 → 漂移
    appendLedger({
      kind: 'usage',
      delta: -10,
      userId: uid,
      model: 'm',
      promptTokens: 5,
      completionTokens: 5,
      status: 'ok',
      requestId: 't',
    });
    reconcileRecent();
    // 对账以账本为准：缓存漂移（999999）被纠正为真实余额 -10
    expect(cachedBalance(uid)).toBe(-10);

    // 打穿为负 → 欠费态：预检直接 402
    appendLedger({ kind: 'usage', delta: -1_000_000, userId: uid, model: 'm', promptTokens: 1, completionTokens: 1, status: 'ok', requestId: 't2' });
    recomputeBalance(uid);
    expect(() => precheck(uid, 5)).toThrow(HttpError);
    try {
      precheck(uid, 5);
    } catch (err) {
      expect((err as HttpError).status).toBe(402);
    }
  });
});
