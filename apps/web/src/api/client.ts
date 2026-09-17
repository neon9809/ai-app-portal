import type { ApiErrorBody } from '@aap/shared';
import { withBase } from '../lib/base';

/** 统一 API 错误：携带契约错误码与可选 action（pow/mfa/step-up 挑战） */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly action?: string,
    /** 完整 error 对象（challenge 等附加字段在此） */
    readonly errorBody?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type ApiInit = RequestInit & { json?: unknown };

/** fetch 封装：JSON 收发、credentials、错误契约归一 */
export async function api<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
  const { json, headers, body, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(withBase(path), {
      credentials: 'include',
      ...rest,
      headers: {
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : body,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '网络不可达，请检查服务是否在运行');
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // 非 JSON（极端情况：网关错误页）
      if (!res.ok) throw new ApiError(res.status, 'BAD_RESPONSE', `响应异常(${res.status})`);
      return text as unknown as T;
    }
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.message ?? `请求失败(${res.status})`,
      err?.details,
      err?.action,
      err as unknown as Record<string, unknown>,
    );
  }
  return data as T;
}
