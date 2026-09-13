import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PortalBootstrap } from '@aap/shared';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { closeDb, initDb } from '../db/index.js';
import { seedSettings } from '../lib/settings.js';

let server: Server;
let baseUrl: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aap-test-'));
  initDb({
    file: path.join(tmpDir, 'test.db'),
    migrationsDir: path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '../../drizzle'),
  });
  seedSettings();
  // 测试配置：默认值但关闭 webDist（测试环境无前端产物）
  const cfg = { ...loadConfig({}), webDist: null };
  const app = createApp(cfg);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('W1 冒烟', () => {
  it('GET /api/health 探活', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBeTruthy();
  });

  it('GET /api/portal/bootstrap 返回默认品牌与关闭注册、needsInit=true', async () => {
    const res = await fetch(`${baseUrl}/api/portal/bootstrap`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PortalBootstrap;
    expect(body.branding.siteName).toBe('AI应用门户');
    expect(body.registration.mode).toBe('closed');
    expect(body.needsInit).toBe(true);
  });

  it('未知 /api 路径返回 JSON 404（不被 SPA 兜底吞掉）', async () => {
    const res = await fetch(`${baseUrl}/api/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
