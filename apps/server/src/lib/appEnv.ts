/**
 * 应用环境变量 / 机密（G6）：manifest.env 声明 + app_env_vars 加密存储。
 *  - envValues：沙箱拉起时注入（sandbox.baseEnv 调用），存储值优先，未配置回退声明 default
 *  - missingRequiredEnv：invoked 执行 / persistent 拉起前强校验必填项
 * 密文出入只经过本模块与配置 API；值永不进日志。
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { appEnvVars, apps } from '../db/schema.js';
import { decryptSecret } from './cryptoSecrets.js';
import { parseEnvSpec } from '../gateway/staticApp.js';

function envSpecOf(appId: string): Record<string, import('../gateway/staticApp.js').ManifestEnvVar> {
  const row = getDb().select({ manifestJson: apps.manifestJson }).from(apps).where(eq(apps.id, appId)).get();
  if (!row?.manifestJson) return {};
  try {
    const manifest = JSON.parse(row.manifestJson) as Record<string, unknown>;
    return parseEnvSpec(manifest.env);
  } catch {
    return {};
  }
}

function storedEnvRows(appId: string): Array<{ name: string; valueEnc: string; isSecret: boolean }> {
  return getDb()
    .select({ name: appEnvVars.name, valueEnc: appEnvVars.valueEnc, isSecret: appEnvVars.isSecret })
    .from(appEnvVars)
    .where(eq(appEnvVars.appId, appId))
    .all();
}

/** 沙箱注入值：已配置的存储值（解密）优先，未配置的非机密回退声明默认值。
 *  解密失败的条目跳过（密文损坏不该拖垮整个应用启动）。 */
export function envValues(appId: string): Record<string, string> {
  const spec = envSpecOf(appId);
  const out: Record<string, string> = {};
  for (const [name, s] of Object.entries(spec)) {
    if (s.default != null) out[name] = s.default;
  }
  for (const r of storedEnvRows(appId)) {
    try {
      out[r.name] = decryptSecret(r.valueEnc);
    } catch {
      /* 密文损坏：跳过该变量 */
    }
  }
  return out;
}

/** 必填变量中尚未配置（且无 default）的名单 */
export function missingRequiredEnv(appId: string): string[] {
  const have = new Set<string>();
  for (const r of storedEnvRows(appId)) have.add(r.name);
  return Object.entries(envSpecOf(appId))
    .filter(([name, s]) => s.required && s.default == null && !have.has(name))
    .map(([name]) => name);
}
