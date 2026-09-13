import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const r = (p: string) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), p);

// 开发代理：/api 与 /app（应用网关）都打到本地服务端（8080）；
// ws: true 为 W5 的 WebSocket 反代预铺。
export default defineConfig({
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
