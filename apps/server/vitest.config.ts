import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // 每个测试文件独立的进程/模块图，db 单例互不串扰
    pool: 'forks',
    testTimeout: 15000,
  },
});
