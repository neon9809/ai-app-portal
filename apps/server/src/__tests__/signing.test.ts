/**
 * G4 包签名信任链测试（Ed25519）：
 * sign-aap.mjs keygen/sign 工具 → 上传验签四态：
 *   verified（信任公钥 → 免审 approved）/ untrusted（照常审核）/ invalid（篡改硬拒）。
 * 依赖仓库根 devDependency adm-zip（CLI 复用）。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { setupTestDb, teardownTestDb } from './testkit.js';
import { closeDb, getDb } from '../db/index.js';
import { seedSettings } from '../lib/settings.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';
import { trustedSigningKeys } from '../db/schema.js';
import { writeLocalCredentials } from '../lib/bootstrap.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const CLI = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  '../../../../packages/aap-sdk/sign-aap.mjs',
);

let server: Server;
let base: string;
let dir: string;
let adminCookie = '';
const tmpDirs: string[] = [];

function zipPkg(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

function cookieOf(res: Response): string {
  const cookies = res.headers.getSetCookie();
  const sid = cookies.find((c) => c.startsWith('aap_sid='));
  if (!sid) throw new Error('no session cookie');
  return sid.split(';')[0]!;
}

function tmpdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aapsign-'));
  tmpDirs.push(d);
  return d;
}

/** CLI keygen：返回私钥文件与公钥 base64 */
function keygen(): { secretFile: string; pubB64: string } {
  const d = tmpdir();
  execSync(`node ${JSON.stringify(CLI)} keygen -o ${JSON.stringify(path.join(d, 'k.secret'))}`, { cwd: d, stdio: 'pipe' });
  return { secretFile: path.join(d, 'k.secret'), pubB64: fs.readFileSync(path.join(d, 'k.pub'), 'utf8').trim() };
}

function signWithCli(zipBuf: Buffer, secretFile: string, signer: string): Buffer {
  const d = tmpdir();
  const pkg = path.join(d, 'pkg.neon-aap');
  fs.writeFileSync(pkg, zipBuf);
  execSync(
    `node ${JSON.stringify(CLI)} sign ${JSON.stringify(pkg)} --key ${JSON.stringify(secretFile)} --signer ${JSON.stringify(signer)}`,
    { cwd: d, stdio: 'pipe' },
  );
  return fs.readFileSync(pkg);
}

function keyIdOfB64(pubB64: string): string {
  return 'SHA256:' + createHash('sha256').update(Buffer.from(pubB64, 'base64')).digest('hex').slice(0, 16);
}

function submit(dataBase64: string): Promise<{ status: number; body: { review?: string; error?: { code?: string } } }> {
  return fetch(`${base}/api/apps/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: adminCookie },
    body: JSON.stringify({ filename: 'pkg.neon-aap', dataBase64 }),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as { review?: string; error?: { code?: string } } }));
}

import { apps } from '../db/schema.js';
import { eq } from 'drizzle-orm';

function rowOf(id: string): { signatureStatus: string | null; reviewStatus: string } {
  const r = getDb()
    .select({ signatureStatus: apps.signatureStatus, reviewStatus: apps.reviewStatus })
    .from(apps)
    .where(eq(apps.id, id))
    .get()!;
  return r;
}

beforeAll(async () => {
  ({ dir } = setupTestDb());
  seedSettings();

  server = createApp({ ...loadConfig({}), webDist: null }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  getDb()
    .insert((await import('../db/schema.js')).users)
    .values({ kind: 'local', username: 'admin', name: '管理员', role: 'admin', createdAt: Date.now() })
    .run();
  const adminId = getDb().select().from((await import('../db/schema.js')).users).get()!.id;
  await writeLocalCredentials(adminId, 'admin-password');
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'admin', password: 'admin-password' }),
  });
  adminCookie = cookieOf(login);
});

afterAll(() => {
  server.close();
  closeDb();
  teardownTestDb(dir);
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const OFFICIAL_MANIFEST = {
  name: 'officialpkg',
  display_name: '官方包',
  version: '1.0.0',
  type: 'html',
  entry: 'index.html',
};

describe('G4 包签名信任链（Ed25519）', () => {
  it('官方签名：信任公钥命中 → verified + 免审 approved', async () => {
    const { secretFile, pubB64 } = keygen();
    getDb()
      .insert(trustedSigningKeys)
      .values({ keyId: keyIdOfB64(pubB64), name: '官方发布', publicKey: pubB64, builtin: true, createdAt: Date.now() })
      .run();

    const signed = signWithCli(
      zipPkg({
        'manifest.json': JSON.stringify(OFFICIAL_MANIFEST),
        'index.html': '<h1>official</h1>',
      }),
      secretFile,
      'neon',
    );
    const r = await submit(signed.toString('base64'));
    expect(r.status).toBe(200);

    expect(r.body.review).toBe('approved');
    expect(rowOf('officialpkg')).toEqual({ signatureStatus: 'verified', reviewStatus: 'approved' });
  });

  it('未信任签名者：签名有效但 key 未知 → untrusted，照常走审核', async () => {
    const { secretFile } = keygen(); // 未加入信任列表
    const signed = signWithCli(
      zipPkg({
        'manifest.json': JSON.stringify({ ...OFFICIAL_MANIFEST, name: 'strangerpkg', display_name: 'Stranger' }),
        'index.html': '<h1>x</h1>',
      }),
      secretFile,
      'stranger',
    );
    const r = await submit(signed.toString('base64'));
    expect(r.status).toBe(200);
    expect(r.body.review).toBe('none');
    expect(rowOf('strangerpkg')).toEqual({ signatureStatus: 'untrusted', reviewStatus: 'none' });
  });

  it('篡改包：签名后增删改文件 → invalid 硬拒上传', async () => {
    const { secretFile } = keygen();
    const signedZipBuf = signWithCli(
      zipPkg({
        'manifest.json': JSON.stringify({ ...OFFICIAL_MANIFEST, name: 'tamperedpkg', display_name: 'Tampered' }),
        'index.html': '<h1>orig</h1>',
      }),
      secretFile,
      'neon',
    );
    // 签名后再改内容（换成未签名的第二份内容 + 原 signature.json 不动）
    const zip = new AdmZip(signedZipBuf);
    zip.updateFile('index.html', Buffer.from('<h1>evil</h1>'));
    const tampered = zip.toBuffer();

    const r = await submit(tampered.toString('base64'));
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('PACKAGE_TAMPERED');
  });
});
