/**
 * 部署基路径（FPK 统一网关形态）：构建期 VITE_BASE 注入（如 /app/ai-app-portal/），
 * 与服务端 GATEWAY_PREFIX 对齐——网关把带前缀请求转发给服务端后由其剥前缀，
 * 前端只需保证「发出的 URL 自带前缀」。默认构建 VITE_BASE='/' 时 APP_BASE 为空串，
 * 所有 URL 与历史行为逐字节一致。
 *
 * 覆盖范围：fetch（api() 收口）、整页跳转/原生 <a href>（绕过 react-router 的场合）。
 * react-router 的 <Link to>/navigate 由 basename 处理，不走这里。
 */
const RAW_BASE: string = import.meta.env.BASE_URL ?? '/';

/** 去尾斜杠的基路径；根部署时为空串 */
export const APP_BASE = RAW_BASE === '/' ? '' : RAW_BASE.replace(/\/+$/, '');

/** 给站内绝对路径拼上部署基路径（入参必须以 / 开头） */
export function withBase(p: string): string {
  return `${APP_BASE}${p}`;
}
