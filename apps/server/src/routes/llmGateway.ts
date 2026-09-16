/**
 * LLM 网关端点（C1/C4/C5/C6）：
 *   POST /v1/chat/completions（含流式）、GET /v1/models
 * 认证：Authorization: Bearer <网关凭据>（C2）；用户归因：应用转发
 * X-AAP-Identity(+Sig) 身份链（passUser 场景随代理注入一并提供）。
 * failover：同模型多上游按 priority 加权逐个尝试（超时/5xx/429 切换）；
 * 流式：SSE 零缓冲透传，注入 stream_options.include_usage 捕获用量，
 * 不在流中途掐断（预估先行、事后校正——C6 语义）。
 */
import { Router, type Request, type Response, type NextFunction } from 'express';

import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { getSetting, getSettingInt } from '../lib/settings.js';
import { HttpError } from '../lib/httpError.js';
import { h } from '../lib/httpError.js';
import {
  appLlmAllowed,
  llmPerMinuteDefault,
  modelCatalog,
  precheck,
  recordUsage,
  resolveAppToken,
  resolveRouteCandidates,
  settleEstimate,
  type AppTokenRow,
} from '../lib/llm.js';
import { verifyIdentity } from '../gateway/identity.js';

export const llmGatewayRouter = Router();

// 超时即时读设置（LLM_TTFB_TIMEOUT_SECONDS / LLM_TOTAL_TIMEOUT_SECONDS，管理端改完即生效）：
// 流式首字节超时（超时切候选；建立后不断流）；非流式整体超时
function ttfbTimeoutMs(): number {
  return Math.max(3, getSettingInt('LLM_TTFB_TIMEOUT_SECONDS', 15)) * 1000;
}
function fullTimeoutMs(): number {
  return Math.max(10, getSettingInt('LLM_TOTAL_TIMEOUT_SECONDS', 120)) * 1000;
}
const DEFAULT_TOKEN_PER_MIN = 60;

function openaiError(status: number, code: string, message: string): { status: number; body: { error: { message: string; type: string; code: string } } } {
  return { status, body: { error: { message, type: 'ai_app_portal_error', code } } };
}

// ---------- 认证与应用级限流（C2/C5） ----------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      llmToken?: AppTokenRow;
    }
  }
}

llmGatewayRouter.use('/v1', (req: Request, res: Response, next: NextFunction): void => {
  const auth = req.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
  const token = resolveAppToken(bearer);
  if (!token) {
    const { status, body } = openaiError(401, 'invalid_api_key', '无效的网关凭据（Bearer token）');
    res.status(status).json(body);
    return;
  }
  // 应用级限流：每凭据固定窗口计数（默认 60/min，可在凭据上覆写）
  const key = `llm:${token.id}`;
  const now = Date.now();
  const win = llmRateHits.get(key);
  const limit = token.perMinuteLimit ?? llmPerMinuteDefault();
  if (!win || now - win.start >= 60_000) {
    llmRateHits.set(key, { start: now, count: 1 });
    if (llmRateHits.size > 5000) {
      for (const [k, v] of llmRateHits) if (now - v.start >= 60_000) llmRateHits.delete(k);
    }
  } else {
    win.count++;
    if (win.count > limit) {
      const { status, body } = openaiError(429, 'rate_limit_exceeded', `该应用凭据请求超过 ${limit}/分`);
      res.status(status).json(body);
      return;
    }
  }
  getDbTouch(token);
  req.llmToken = token;
  next();
});

const llmRateHits = new Map<string, { start: number; count: number }>();
import { getSqlite } from '../db/index.js';
function getDbTouch(token: AppTokenRow): void {
  getSqlite()
    .prepare('UPDATE llm_app_tokens SET last_used_at = ? WHERE id = ?')
    .run(Date.now(), token.id);
}

// ---------- 用户归因（passUser 身份链转发） ----------

/** 应用转发门户注入的身份头 → 归因到用户；无头/验签失败 → null（仅应用级计量） */
function attributeUser(req: Request, appId: string): number | null {
  const payload = req.headers['x-aap-identity'];
  const sig = req.headers['x-aap-identity-sig'];
  if (typeof payload !== 'string' || typeof sig !== 'string') return null;
  const secret = getSetting('AAP_SIGN_SECRET');
  if (!secret) return null;
  const v = verifyIdentity(payload, sig, secret, appId);
  if (!v.ok) return null;
  const uid = Number(v.payload.uid);
  return Number.isInteger(uid) && uid > 0 ? uid : null;
}

// ---------- GET /v1/models ----------

llmGatewayRouter.get(
  '/v1/models',
  h(async (req: Request, res: Response) => {
    void req.llmToken;
    const now = Math.floor(Date.now() / 1000);
    res.json({
      object: 'list',
      data: modelCatalog().map((m) => ({ id: m, object: 'model', created: now, owned_by: 'ai-app-portal' })),
    });
  }),
);

// ---------- POST /v1/chat/completions ----------

interface ChatBody {
  model?: string;
  messages?: unknown;
  stream?: boolean;
  max_tokens?: number;
  [k: string]: unknown;
}

llmGatewayRouter.post(
  '/v1/chat/completions',
  h(async (req: Request, res: Response) => {
    const token = req.llmToken!;
    const body = (req.body ?? {}) as ChatBody;
    // 能力声明闸（G1，审计 F1）：AAP_TOKEN 对全部包注入（egress 凭据），
    // 未声明 llm 的包不得凭它直连 /v1 花运行用户余额——与 /api/aap/llm/chat 同一判定
    if (!appLlmAllowed(token.appId)) {
      const { status, body: e } = openaiError(
        403,
        'capability_not_declared',
        '该应用 manifest 未声明 llm 能力，不能调用对话网关（请在 capabilities 声明 llm 后重新上传）',
      );
      res.status(status).json(e);
      return;
    }
    const model = String(body.model ?? '');
    if (!model || !Array.isArray(body.messages)) {
      const { status, body: e } = openaiError(400, 'invalid_request_error', '缺少 model 或 messages');
      res.status(status).json(e);
      return;
    }
    const candidates = resolveRouteCandidates(model);
    if (candidates.length === 0) {
      const { status, body: e } = openaiError(404, 'model_not_found', `模型 ${model} 不在网关目录中`);
      res.status(status).json(e);
      return;
    }

    const requestId = randomBytes(8).toString('hex');
    const userId = attributeUser(req, token.appId);
    const multiplier = candidates[0]!.multiplier;
    const stream = body.stream === true;
    // 预估成本：max_tokens 优先，缺省 1024（C6：预估先行、事后校正、不中途掐断）
    const estimatedCost = Math.max(1, Math.ceil((((body.max_tokens as number | undefined) ?? 1024) * multiplier) / 100));
    precheck(userId, estimatedCost);

    const started = Date.now();

    let lastError = 'no candidate';
    for (const candidate of candidates) {
      const url = candidate.upstreamBaseUrl.replace(/\/+$/, '') + '/chat/completions';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), stream ? ttfbTimeoutMs() : fullTimeoutMs());
      try {
        const up = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${candidate.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            ...body,
            model: candidate.upstreamModel,
            ...(stream ? { stream_options: { include_usage: true } } : {}),
          }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);

        // 可切换错误：5xx/429/408 → failover 下一候选
        if (up.status >= 500 || up.status === 429 || up.status === 408) {
          lastError = `upstream ${up.status}`;
          up.body?.cancel();
          continue;
        }
        if (!up.ok) {
          // 客户端类错误（参数/key 无效）：原样透传，不切换；本次无实际用量，
          // 预检扣减的预估成本全额退回（否则错误请求会白扣用户余额）
          const text = await up.text();
          recordUsage({
            userId,
            appId: token.appId,
            model,
            promptTokens: 0,
            completionTokens: 0,
            multiplier,
            latencyMs: Date.now() - started,
            status: 'error',
            requestId,
          });
          settleEstimate(userId, estimatedCost, 0);
          res.status(up.status).type('application/json').set('x-aap-request-id', requestId).send(text);
          return;
        }

        if (stream && up.body) {
          await streamPassthrough(req, res, up as unknown as globalThis.Response, {
            userId,
            appId: token.appId,
            model,
            multiplier: candidate.multiplier, // 按实际服务的候选计费（各上游倍率可不同）
            started,
            requestId,
            estimatedCost,
          });
          return;
        }

        // 非流式：读 JSON → 计量 → 回传
        const json = (await up.json()) as {
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          [k: string]: unknown;
        };
        const promptTokens = json.usage?.prompt_tokens ?? estimateTokens(body.messages);
        const completionTokens = json.usage?.completion_tokens ?? 0;
        recordUsage({
          userId,
          appId: token.appId,
          model,
          promptTokens,
          completionTokens,
          multiplier: candidate.multiplier,
          latencyMs: Date.now() - started,
          status: 'ok',
          requestId,
        });
        settleEstimate(userId, estimatedCost, Math.ceil(((promptTokens + completionTokens) * candidate.multiplier) / 100));
        res.status(200).set('x-aap-request-id', requestId).json(json);
        return;
      } catch (err) {
        clearTimeout(timer);
        lastError = err instanceof Error ? err.message : String(err);
        // 超时/网络错误 → 下一候选
      }
    }

    recordUsage({
      userId,
      appId: token.appId,
      model,
      promptTokens: 0,
      completionTokens: 0,
      multiplier,
      latencyMs: Date.now() - started,
      status: 'error',
      requestId,
    });
    // 全部候选失败：无实际用量，退回预检扣减的预估成本
    settleEstimate(userId, estimatedCost, 0);
    const { status, body: e } = openaiError(502, 'upstream_error', `所有上游均不可用（最后错误：${lastError}）`);
    res.status(status).set('x-aap-request-id', requestId).json(e);
  }),
);

/** SSE 零缓冲透传 + 增量提取 usage；客户端断开即销毁上游流 */
async function streamPassthrough(
  req: Request,
  res: Response,
  up: globalThis.Response,
  meta: {
    userId: number | null;
    appId: string;
    model: string;
    multiplier: number;
    started: number;
    requestId: string;
    estimatedCost: number;
  },
): Promise<void> {
  res.status(200);
  res.setHeader('content-type', up.headers.get('content-type') ?? 'text/event-stream');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-aap-request-id', meta.requestId);
  res.flushHeaders?.();

  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  let carry = '';

  const reader = up.body!.getReader();
  const dec = new TextDecoder();
  let closed = false;
  res.on('close', () => {
    closed = true;
    void reader.cancel().catch(() => {});
  });

  // 流式闲置超时：建连后若连续 N 秒无新字节（上游挂起），主动断开并按已收
  // usage 结算——避免请求无限占用客户端与网关连接（预估会按实际用量校正）
  const idleMs = Math.max(5, getSettingInt('LLM_STREAM_IDLE_TIMEOUT', 60)) * 1000;
  let idleTimer: NodeJS.Timeout | null = setTimeout(() => {
    void reader.cancel().catch(() => {});
  }, idleMs);
  const bumpIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void reader.cancel().catch(() => {});
    }, idleMs);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || closed) break;
      res.write(value);
      bumpIdle();
      // 增量解析 SSE data 行，捕获 usage（通常在最后一个 chunk）
      carry += dec.decode(value, { stream: true });
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
          if (json.usage) usage = json.usage;
        } catch {
          /* 非完整 JSON 行，跳过 */
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
  res.end();

  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  recordUsage({
    userId: meta.userId,
    appId: meta.appId,
    model: meta.model,
    promptTokens,
    completionTokens,
    multiplier: meta.multiplier,
    latencyMs: Date.now() - meta.started,
    status: 'ok',
    requestId: meta.requestId,
  });
  // 流式不中途掐断：预估已扣，实际用量事后校正缓存（账本只记实际）
  settleEstimate(meta.userId, meta.estimatedCost, Math.ceil(((promptTokens + completionTokens) * meta.multiplier) / 100));
}

/** 请求体 token 估算兜底（上游未回 usage 时按字符数/4 估） */
function estimateTokens(messages: unknown): number {
  try {
    const text = JSON.stringify(messages);
    return Math.max(1, Math.ceil(text.length / 4));
  } catch {
    return 1;
  }
}
