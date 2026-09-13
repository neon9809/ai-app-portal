import path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  timeout: 90_000,
  globalSetup: require.resolve('./global-setup-entry'),
  globalTeardown: require.resolve('./global-teardown'),
  use: {
    baseURL: 'http://127.0.0.1:9910',
    locale: 'zh-CN',
    viewport: { width: 1280, height: 800 },
  },
  reporter: [['list']],
  // 同一 worker 串行执行（共享服务端状态）
  workers: 1,
  outputDir: path.join(__dirname, '.run', 'artifacts'),
});
