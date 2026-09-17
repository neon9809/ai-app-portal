/**
 * FPK 统一网关接入（deploy/fpk）：
 *  - GATEWAY_PREFIX 前缀剥离（lib/gatewayPrefix.ts）的单元与集成行为；
 *  - TCP + Unix Socket 双 http.Server 监听（server.ts 同构装配）；
 *  - 应用 ID 与网关前缀冲突守卫（registry.idConflictsWithGatewayPrefix）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { closeDb, initDb } from '../db/index.js';
import { seedSettings } from '../lib/settings.js';
import { stripGatewayPrefix } from '../lib/gatewayPrefix.js';
import { idConflictsWithGatewayPrefix } from '../gateway/registry.js';

const PREFIX = '/app/ai-app-portal';

describe('stripGatewayPrefix 单元', () => {
  it('无前缀配置时恒等', () => {
    expect(stripGatewayPrefix('/api/health', null)).toBe('/api/health');
    expect(stripGatewayPrefix(undefined, PREFIX)).toBeUndefined();
  });

  it('精确段匹配并保留 query', () => {
    expect(stripGatewayPrefix(PREFIX, PREFIX)).toBe('/');
    expect(stripGatewayPrefix(`${PREFIX}/`, PREFIX)).toBe('/');
    expect(stripGatewayPrefix(`${PREFIX}/api/health`, PREFIX)).toBe('/api/health');
    expect(stripGatewayPrefix(`${PREFIX}?x=1`, PREFIX)).toBe('/?x=1');
    expect(stripGatewayPrefix(`${PREFIX}/?x=1`, PREFIX)).toBe('/?x=1');
  });

  it('同前缀异段不吞（/prefix-evil）', () => {
    expect(stripGatewayPrefix(`${PREFIX}-evil/x`, PREFIX)).toBe(`${PREFIX}-evil/x`);
    expect(stripGatewayPrefix(`${PREFIX}abc`, PREFIX)).toBe(`${PREFIX}abc`);
    expect(stripGatewayPrefix('/other/path', PREFIX)).toBe('/other/path');
  });
});

describe('loadConfig 网关形态字段', () => {
  it('GATEWAY_PREFIX/SOCKET_PATH/HOST 解析与尾斜杠归一', () => {
    const cfg = loadConfig({
      GATEWAY_PREFIX: '/app/ai-app-portal/',
      SOCKET_PATH: '/run/aap/app.sock',
      HOST: '127.0.0.1',
      DATA_DIR: './data-x',
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.gatewayPrefix).toBe('/app/ai-app-portal');
    expect(cfg.socketPath).toBe('/run/aap/app.sock');
    expect(cfg.host).toBe('127.0.0.1');
    const plain = loadConfig({ DATA_DIR: './data-y' } as unknown as NodeJS.ProcessEnv);
    expect(plain.gatewayPrefix).toBeNull();
    expect(plain.socketPath).toBeNull();
    expect(plain.host).toBeNull();
  });
});

describe('idConflictsWithGatewayPrefix', () => {
  it('与网关前缀末段同名即冲突（大小写不敏感），否则放行', () => {
    expect(idConflictsWithGatewayPrefix('ai-app-portal', PREFIX)).toBe(true);
    expect(idConflictsWithGatewayPrefix('AI-App-Portal', PREFIX)).toBe(true);
    expect(idConflictsWithGatewayPrefix('ai-app-portalx', PREFIX)).toBe(false);
    expect(idConflictsWithGatewayPrefix('ip-analyzer', PREFIX)).toBe(false);
    expect(idConflictsWithGatewayPrefix('anything', null)).toBe(false);
  });
});

describe('统一网关集成（前缀剥离 + TCP/Unix Socket 双监听）', () => {
  let tcp: Server;
  let sock: Server;
  let socketPath: string;
  let tcpUrl: string;
  let tmpDir: string;

  /** 与 server.ts 同构：入口层剥前缀 → Express；TCP 与 Socket 两个实例共享 handler */
  function makeServers(): void {
    const cfg = { ...loadConfig({ DATA_DIR: tmpDir } as unknown as NodeJS.ProcessEnv), webDist: null };
    const app = createApp(cfg);
    const requestHandler: http.RequestListener = (req, res) => {
      req.url = stripGatewayPrefix(req.url, PREFIX);
      app(req, res);
    };
    tcp = http.createServer(requestHandler);
    sock = http.createServer(requestHandler);
    socketPath = path.join(tmpDir, 'app.sock');
    fs.rmSync(socketPath, { force: true });
  }

  function get(opts: http.RequestOptions): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.get(opts, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
    });
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aap-gw-'));
    initDb({
      file: path.join(tmpDir, 't.db'),
      migrationsDir: path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '../../drizzle'),
    });
    seedSettings();
    makeServers();
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => sock.listen(socketPath, r));
    tcpUrl = `http://127.0.0.1:${(tcp.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((r) => tcp.close(() => r())),
      new Promise<void>((r) => sock.close(() => r())),
    ]);
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('带网关前缀的 /api 请求经剥离后命中路由（socket 通道）', async () => {
    const res = await get({ socketPath, path: `${PREFIX}/api/health` });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
  });

  it('带网关前缀的根路径返回 SPA 兜底（socket 通道，webDist=null 时 404 JSON/HTML 兜底）', async () => {
    const res = await get({ socketPath, path: `${PREFIX}/` });
    expect(res.status).toBeLessThan(500);
  });

  it('TCP 通道根路径语义不变（无前缀直连仍可用）', async () => {
    const res = await get({ hostname: '127.0.0.1', port: new URL(tcpUrl).port, path: '/api/health' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
  });

  it('同前缀异段路径不被剥离（不命中 /api）', async () => {
    const res = await get({ socketPath, path: `${PREFIX}-evil/api/health` });
    expect(res.status).not.toBe(200);
  });
});
