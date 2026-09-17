/**
 * FPK 统一网关前缀剥离（飞牛 fnOS gatewayPrefix 入口）。
 *
 * 网关把 https://<nas>/app/<appname>/... 转发到本服务的 Unix Socket，路径带着
 * /app/<appname> 前缀。本服务在 HTTP 与 WS upgrade 两个入口的「最外层」剥掉前缀，
 * 内部路由保持根路径语义：SPA 资源（构建期 VITE_BASE 对齐同一前缀）、/api、
 * /app/<id> 应用反代（B1）全部零改动；未配置 GATEWAY_PREFIX 时为恒等函数，
 * 端口/容器形态行为不变。
 *
 * 必须挂在 Express 之前（原始 req.url 上）做，否则 req.originalUrl 会把
 * 带前缀路径固化进大包体白名单等判断。
 */

/**
 * 返回剥离网关前缀后的 url。
 * 只做「完整段」匹配：/pre、/pre/、/pre/xxx、/pre?x=1 都命中；
 * /prefix-evil 这类恰好同前缀的其他路径不吞。
 */
export function stripGatewayPrefix(
  rawUrl: string | undefined,
  prefix: string | null | undefined,
): string | undefined {
  if (!prefix || !rawUrl) return rawUrl;
  if (rawUrl === prefix) return '/';
  if (!rawUrl.startsWith(prefix)) return rawUrl;
  const next = rawUrl[prefix.length];
  if (next === '?') return `/${rawUrl.slice(prefix.length)}`;
  if (next === '/') return rawUrl.slice(prefix.length);
  return rawUrl;
}
