/**
 * M2 LLM 网关集成测试（C1–C6）：
 * mock OpenAI 兼容上游（正常/必败/流式），验证凭据认证、模型目录聚合、
 * failover、SSE 零缓冲透传与 usage 捕获、账本计量、预检 402、调额。
 */
import http from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { closeDb, getDb } from '../db/index.js';
import { seedSettings, setSetting } from '../lib/settings.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { llmBalanceCache } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  createAppToken,
  createRoute,
  createUpstream,
  grantTokens,
  cachedBalance,
  recomputeBalance,
} from '../lib/llm.js';
import { signIdentity } from '../gateway/identity.js';
import { getSetting } from '../lib/settings.js';

/** 生成合法的 passUser 身份头（模拟门户代理注入、应用转发） */
function identityHeaders(uid: number, appId = 'demo'): Record<string, string> {
  const user = {
    id: uid,
    kind: 'local',
    subject: `local:u${uid}`,
    username: `u${uid}`,
    email: null,
    name: `u${uid}`,
    role: 'user',
    status: 'active',
    sessionId: 'test',
    authState: 'full',
    stepUpUntil: null,
    plan: 'free',
    mfaEnabled: false,
    mustChangePassword: false,
  };
  const idn = signIdentity(user as never, appId);
  const secret = getSetting('AAP_SIGN_SECRET')!;
  return { 'x-aap-identity': idn!.payload, 'x-aap-identity-sig': idn!.sig };
}

let gw: Server;
let gwPort = 0;
let dir: string;
const okUpstreams: Server[] = [];
const AUTH = { authorization: '' };

function upServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => handler(req, res, data));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
    void handler;
  });
}

const OK_BODY = JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

beforeAll(async () => {
  ({ dir } = setupTestDb());
  seedSettings();

  // 上游 A：正常；上游 B：总是 500（failover 用）；上游 C：流式
  const a = await upServer((_q, res, body) => {
    if (JSON.parse(body || '{}').model === 'boom') {
      res.writeHead(500).end('boom');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(OK_BODY);
  });
  okUpstreams.push(a.server);
  const b = await upServer((_q, res) => {
    res.writeHead(500).end('always-fail');
  });
  okUpstreams.push(b.server);
  const c = await upServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  okUpstreams.push(c.server);

  // 网关
  const cfg = { ...loadConfig({}), webDist: null };
  gw = createApp(cfg).listen(0, '127.0.0.1');
  await new Promise<void>((r) => gw!.once('listening', r));
  gwPort = (gw.address() as AddressInfo).port;

  // 路由与凭据
  const aId = createUpstream('正常上游', a.baseUrl, 'sk-up-a');
  const bId = createUpstream('必败上游', b.baseUrl, 'sk-up-b');
  const cId = createUpstream('流式上游', c.baseUrl, 'sk-up-c');
  createRoute({ model: 'test-model', upstreamId: aId, upstreamModel: 'real-model-a', multiplier: 100 });
  createRoute({ model: 'failover-model', upstreamId: bId, upstreamModel: 'real-b', priority: 1 });
  createRoute({ model: 'failover-model', upstreamId: aId, upstreamModel: 'real-model-a', priority: 2 });
  createRoute({ model: 'stream-model', upstreamId: cId, upstreamModel: 'real-stream', multiplier: 100 });
  createRoute({ model: 'dead-model', upstreamId: bId, upstreamModel: 'real-b' });

  const token = createAppToken('demo', 'e2e', null);
  AUTH.authorization = `Bearer ${token}`;
});

afterAll(async () => {
  await new Promise<void>((r) => gw.close(() => r()));
  for (const s of okUpstreams) await new Promise<void>((r) => s.close(() => r()));
  closeDb();
  teardownTestDb(dir);
});

function balanceOf(userId: number): number {
  return cachedBalance(userId) ?? recomputeBalance(userId);
}

async function chat(payload: Record<string, unknown>, auth = AUTH): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.text() };
}

describe('M2 LLM 网关（C1–C6）', () => {
  const U1 = 501;

  it('凭据认证：无 token 401；/v1/models 聚合目录', async () => {
    const no = await fetch(`http://127.0.0.1:${gwPort}/v1/models`);
    expect(no.status).toBe(401);

    const res = await fetch(`http://127.0.0.1:${gwPort}/v1/models`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain('test-model');
    expect(ids).toContain('failover-model');
    expect(ids).toContain('stream-model');
  });

  it('model_not_found → 404', async () => {
    const { status } = await chat({ model: 'nope', messages: [] });
    expect(status).toBe(404);
  });

  it('非流式对话：转发 + usage 入账（账本 delta 为负）+ 预估事后校正', async () => {
    grantTokens(U1, 100_000, '测试额度', 1);
    const before = balanceOf(U1);

    const { status, body } = await chat({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }, { ...AUTH, ...identityHeaders(U1) });
    expect(status).toBe(200);
    expect(JSON.parse(body).choices[0].message.content).toBe('pong');

    // usage: 10+5=15 → cost = ceil(15*100/100) = 15
    expect(balanceOf(U1)).toBe(before - 15);
  });

  it('failover：主上游 5xx 自动切备用；全败 502', async () => {
    grantTokens(U1, 100_000, 'f', 1);
    const before = balanceOf(U1);
    const { status, body } = await chat({ model: 'failover-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 }, { ...AUTH, ...identityHeaders(U1) });
    expect(status).toBe(200);
    expect(JSON.parse(body).choices[0].message.content).toBe('pong');
    expect(balanceOf(U1)).toBeLessThan(before);

    const dead = await chat({ model: 'dead-model', messages: [{ role: 'user', content: 'x' }], max_tokens: 10 }, { ...AUTH, ...identityHeaders(U1) });
    expect(dead.status).toBe(502);
    expect(JSON.parse(dead.body).error.type).toBe('ai_app_portal_error');
  });

  it('失败路径退款：全候选失败（502）不白扣预估成本（测试内无结算循环，退款须来自即时校正）', async () => {
    grantTokens(U1, 100_000, 'refund', 1);
    const before = balanceOf(U1);
    // max_tokens=4096 → 预检曾扣减大额预估；修复前该扣减永久丢失
    const dead = await chat(
      { model: 'dead-model', messages: [{ role: 'user', content: 'x' }], max_tokens: 4096 },
      { ...AUTH, ...identityHeaders(U1) },
    );
    expect(dead.status).toBe(502);
    expect(balanceOf(U1)).toBe(before);
  });

  it('流式：SSE 透传 + 末帧 usage 捕获入账', async () => {
    grantTokens(U1, 100_000, 's', 1);
    const before = balanceOf(U1);
    const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH, ...identityHeaders(U1) },
      body: JSON.stringify({ model: 'stream-model', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 30 }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"content":"he"');
    expect(text).toContain('[DONE]');

    // usage 7+3=10 → cost 10
    expect(balanceOf(U1)).toBe(before - 10);
  });

  it('预检闸门：余额不足 → 402，请求不出网关', async () => {
    const U2 = 502;
    grantTokens(U2, 5, '小额', 1);
    const { status, body } = await chat({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1000 }, { ...AUTH, ...identityHeaders(U2) });
    expect(status).toBe(402);
    const err = JSON.parse(body).error;
    expect(err.code).toBe('INSUFFICIENT_BALANCE');
    expect(err.balance).toBe(5);
    // 缓存未被扣穿成负数
    expect(balanceOf(U2)).toBe(5);
  });

  it('调额：发放/调减 + 缓存同步（三触发之手动调额）', async () => {
    const U3 = 503;
    grantTokens(U3, 500, 'initial', 1);
    expect(balanceOf(U3)).toBe(500);
    grantTokens(U3, -200, '调减', 1);
    expect(balanceOf(U3)).toBe(300);
    grantTokens(U3, 1000, '充值到账模拟', 1);
    expect(balanceOf(U3)).toBe(1300);
    // 缓存行与重算一致
    expect(getDb().select().from(llmBalanceCache).where(eq(llmBalanceCache.userId, U3)).get()?.balance).toBe(1300);
  });

  it('用户归因：无身份头被预检拒绝（防绕过余额闸门）；有身份头按 (kind,uid) 归因扣减', async () => {
    grantTokens(U1, 100_000, 'anon', 1);
    const before = balanceOf(U1);
    // 无身份头：网关直接 403 拒绝（ATTRIBUTION_REQUIRED），余额与上游均不可及
    const anon = await chat({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 });
    expect(anon.status).toBe(403);
    expect(JSON.parse(anon.body).error.code).toBe('ATTRIBUTION_REQUIRED');
    expect(balanceOf(U1)).toBe(before);
    // 带身份头（应用转发）：归因到 U1，余额扣减
    const uid = 510;
    grantTokens(uid, 500, 'id', 1);
    const before2 = balanceOf(uid);
    const withId = await chat(
      { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 },
      { ...AUTH, ...identityHeaders(uid) },
    );
    expect(withId.status).toBe(200);
    expect(balanceOf(uid)).toBeLessThan(before2);
    void setSetting;
  });
});
