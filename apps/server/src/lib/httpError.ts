/**
 * HTTP 错误契约：路由抛 HttpError，全局错误处理器统一转 JSON。
 * 附带 async 包装（Express 4 不捕获异步异常）。
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** 附加字段（action/challenge/details 等）直接并入 error 对象 */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function toBody(err: HttpError): {
  status: number;
  body: { error: { code: string; message: string } & Record<string, unknown> };
} {
  return {
    status: err.status,
    body: { error: { code: err.code, message: err.message, ...(err.extra ?? {}) } },
  };
}

/** async 路由处理器包装 */
export function h(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
