/**
 * W6 TLS（B3）：PEM 校验/配对、原子安装、HTTPS 起停与热替换。
 * 自签名夹具由 openssl 运行时生成（macOS/Linux 均内置）。
 * ACME 签发流程需要公网 80 端口与 Let's Encrypt 互通，无法离线自动化
 * ——以 acme staging 手动验收为准（W11 集成验收项）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { closeDb } from '../db/index.js';
import { seedSettings } from '../lib/settings.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import * as tls from '../gateway/tls.js';

let dir: string;
let httpsPort: number | null = null;
let pair1: { cert: string; key: string };
let pair2: { cert: string; key: string };
let opensslAvailable = true;

function genSelfSigned(cn: string): { cert: string; key: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aap-cert-'));
  const cert = path.join(tmp, 'cert.pem');
  const key = path.join(tmp, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
    '-days', '365', '-nodes', '-subj', `/CN=${cn}`,
  ], { stdio: 'pipe' });
  return { cert: fs.readFileSync(cert, 'utf8'), key: fs.readFileSync(key, 'utf8') };
}

beforeAll(async () => {
  ({ dir } = setupTestDb());
  seedSettings();
  try {
    pair1 = genSelfSigned('test1.example.com');
    pair2 = genSelfSigned('test2.example.com');
  } catch {
    opensslAvailable = false;
    return;
  }
  const cfg = { ...loadConfig({}), webDist: null };
  const app = createApp(cfg);
  tls.init(app, () => {}, 0); // 0 = 临时端口
  tls.restore();
});

afterAll(() => {
  tls.stop();
  closeDb();
  teardownTestDb(dir);
});

describe('W6 证书校验与安装（B3）', () => {
  it.skipIf(!opensslAvailable)('有效配对：返回证书信息；有效期天数合理', () => {
    const info = tls.validate(pair1.cert, pair1.key);
    expect(info.subject).toContain('test1.example.com');
    expect(info.expired).toBe(false);
    expect(info.daysRemaining).toBeGreaterThan(300);
  });

  it.skipIf(!opensslAvailable)('证书与私钥不配对 → 拒绝', () => {
    expect(() => tls.validate(pair1.cert, pair2.key)).toThrow(/不配对/);
    expect(() => tls.validate('not a pem', pair1.key)).toThrow(/PEM/);
  });

  it.skipIf(!opensslAvailable)('安装 → HTTPS 服务起在临时端口 → 热替换 → 移除', async () => {
    tls.installManual(pair1.cert, pair1.key);
    // 等待监听
    for (let i = 0; i < 50 && !tls.httpsAddress(); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    httpsPort = tls.httpsAddress();
    expect(httpsPort).not.toBeNull();

    // HTTPS 请求可达（自签名忽略校验）
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const res1 = await fetch(`https://127.0.0.1:${httpsPort}/api/health`);
    expect(res1.status).toBe(200);
    const cert1 = (await res1.json() as { ok: boolean }).ok;
    expect(cert1).toBe(true);

    // 热替换为第二张证书：服务不中断
    tls.installManual(pair2.cert, pair2.key);
    expect(tls.httpsAddress()).toBe(httpsPort);
    const res2 = await fetch(`https://127.0.0.1:${httpsPort}/api/health`);
    expect(res2.status).toBe(200);

    const st = tls.status();
    expect(st.installed).toBe(true);
    expect(st.httpsEnabled).toBe(true);
    expect(st.cert?.subject).toContain('test2.example.com');

    tls.remove();
    for (let i = 0; i < 50 && tls.httpsAddress(); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(tls.httpsAddress()).toBeNull();
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  });
});
