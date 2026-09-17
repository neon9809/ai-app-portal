import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const r = (p: string) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), p);

// 开发代理：/api 与 /app（应用网关）都打到本地服务端（8080）；
// ws: true 为 W5 的 WebSocket 反代预铺。
// base（FPK 统一网关形态）：VITE_BASE=/app/ai-app-portal/ 时资源引用与
// import.meta.env.BASE_URL 自带网关前缀（与服务端 GATEWAY_PREFIX 对齐），
// 默认 '/' 行为不变。
const VITE_BASE = process.env.VITE_BASE?.trim() || '/';
const normalizedBase = (() => {
  const trimmed = `/${VITE_BASE.replace(/^\/+|\/+$/g, '')}`;
  return trimmed === '/' ? '/' : `${trimmed}/`;
})();

export default defineConfig({
  base: normalizedBase,
  plugins: [react()],
  resolve: {
    alias: { '@': r('src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080' },
      '/app': { target: 'http://localhost:8080', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
