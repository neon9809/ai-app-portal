/**
 * 验证码通道抽象（A2）：SMTP / SMS adapter 选一首发，M1 首发 SMTP；
 * 未配置 SMTP 时用「日志通道」兜底（内网可离线：验证码打到服务端日志）。
 * 限发硬要求：同通道 60s 限 1 条 + 24h 上限（防短信轰炸刷穿话费的同源问题）。
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { CodePurpose, VerifyChannel } from './types.js';
import { HttpError } from './httpError.js';
import { getDb } from '../db/index.js';
import { verificationCodes } from '../db/schema.js';
import { audit, registerPurgeTask } from './audit.js';
import { getSetting, getSettingInt } from './settings.js';

export type { CodePurpose, VerifyChannel };

const CODE_TTL_MS = 5 * 60 * 1000; // 6 位码 5 分钟有效
const RESEND_INTERVAL_MS = 60 * 1000; // 同通道 60s 限 1 条
export const CODE_LENGTH = 6;

// ---------- 通道实现 ----------

export interface CodeChannel {
  readonly id: VerifyChannel;
  send(target: string, code: string, purpose: CodePurpose): Promise<void>;
}

class LogChannel implements CodeChannel {
  readonly id: VerifyChannel;
  constructor(id: VerifyChannel) {
    this.id = id;
  }
  async send(target: string, code: string, purpose: CodePurpose): Promise<void> {
    // 离线兜底：验证码进服务端日志（自托管单管理员场景可接受）
    console.log(`[dev-${this.id}] 验证码 purpose=${purpose} target=${target} code=${code}（5 分钟内有效）`);
  }
}

class SmtpEmailChannel implements CodeChannel {
  readonly id = 'email' as const;
  async send(target: string, code: string, purpose: CodePurpose): Promise<void> {
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport({
      host: getSetting('SMTP_HOST') ?? '',
      port: getSettingInt('SMTP_PORT', 465),
      secure: getSettingInt('SMTP_PORT', 465) === 465,
      auth: {
        user: getSetting('SMTP_USER') ?? '',
        pass: getSetting('SMTP_PASS') ?? '',
      },
    });
    const from = getSetting('SMTP_FROM') || getSetting('SMTP_USER') || '';
    const site = getSetting('SITE_NAME') || 'AI应用门户';
    const purposeText: Record<CodePurpose, string> = {
      register: '注册账号',
      reset: '重置密码',
      bind: '绑定账号资料',
    };
    await transport.sendMail({
      from,
      to: target,
      subject: `[${site}] 验证码：${code}（${purposeText[purpose]}）`,
      text: `您的验证码是 ${code}，${CODE_TTL_MS / 60000} 分钟内有效。如非本人操作请忽略本邮件。`,
    });
  }
}

/** email 通道：配置了 SMTP 用 SMTP，否则日志兜底 */
export function getEmailChannel(): CodeChannel {
  return getSetting('SMTP_HOST') ? new SmtpEmailChannel() : new LogChannel('email');
}

export function getChannel(id: VerifyChannel): CodeChannel {
  switch (id) {
    case 'email':
      return getEmailChannel();
    case 'phone':
      // M1 不首发 SMS adapter；接口预留（阿里云/腾讯云短信后续按需接）
      throw new HttpError(501, 'CHANNEL_NOT_CONFIGURED', '短信通道未配置，请使用邮箱');
  }
}

export function smtpConfigured(): boolean {
  return Boolean(getSetting('SMTP_HOST'));
}

// ---------- 签发与校验 ----------

function hashCode(code: string): string {
  const salt = randomBytes(8).toString('hex');
  return `${salt}:${createHash('sha256').update(`${salt}:${code}`).digest('hex')}`;
}

function codeMatches(stored: string, code: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  return createHash('sha256').update(`${salt}:${code}`).digest('hex') === hash;
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const name = email.slice(0, at);
  return `${name.slice(0, 1)}***${email.slice(at)}`;
}

export interface IssueResult {
  sentTo: string;
  /** 60s 重发间隔的剩余毫秒（前端做倒计时） */
  resendAfterMs: number;
  /** 日志通道兜底时提示管理员（前端展示「看服务端日志」） */
  viaLogFallback: boolean;
}

/** 签发验证码：限发校验 → 生成 → 哈希入库 → 通道发送 */
export async function issueCode(
  channel: VerifyChannel,
  target: string,
  purpose: CodePurpose,
  ip: string | null,
): Promise<IssueResult> {
  const db = getDb();
  const now = Date.now();

  // 同通道 60s 限 1 条
  const last = db
    .select({ createdAt: verificationCodes.createdAt })
    .from(verificationCodes)
    .where(and(eq(verificationCodes.channel, channel), eq(verificationCodes.target, target)))
    .orderBy(sql`id DESC`)
    .get();
  if (last && now - last.createdAt < RESEND_INTERVAL_MS) {
    throw new HttpError(429, 'CODE_RESEND_TOO_FAST', '发送太频繁，请稍后再试', {
      retryAfterMs: RESEND_INTERVAL_MS - (now - last.createdAt),
    });
  }

  // 24h 上限（防轰炸/刷费）
  const dailyLimit = getSettingInt('CODE_SEND_DAILY_LIMIT', 10);
  const count = db
    .select({ n: sql<number>`count(*)` })
    .from(verificationCodes)
    .where(
      and(
        eq(verificationCodes.channel, channel),
        eq(verificationCodes.target, target),
        gt(verificationCodes.createdAt, now - 24 * 3600_000),
      ),
    )
    .get()?.n ?? 0;
  if (count >= dailyLimit) {
    throw new HttpError(429, 'CODE_DAILY_LIMIT', '今日发送次数已达上限，请明天再试');
  }

  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
  db.insert(verificationCodes)
    .values({
      channel,
      target,
      purpose,
      codeHash: hashCode(code),
      ip,
      createdAt: now,
      expiresAt: now + CODE_TTL_MS,
    })
    .run();

  const ch = getChannel(channel);
  try {
    await ch.send(target, code, purpose);
  } catch (err) {
    console.error('[verification] 通道发送失败:', err);
    throw new HttpError(502, 'CODE_SEND_FAILED', '验证码发送失败，请稍后重试或联系管理员');
  }

  audit(`channel:${channel}`, ip, 'verification.issued', { purpose, target: channel === 'email' ? maskEmail(target) : target });
  return {
    sentTo: channel === 'email' ? maskEmail(target) : target,
    resendAfterMs: RESEND_INTERVAL_MS,
    viaLogFallback: ch instanceof LogChannel,
  };
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

/** 校验验证码：最新未消费未过期行，命中即标记消费（单次有效） */
export function verifyCode(channel: VerifyChannel, target: string, purpose: CodePurpose, code: string): VerifyResult {
  const db = getDb();
  const now = Date.now();
  const row = db
    .select()
    .from(verificationCodes)
    .where(
      and(
        eq(verificationCodes.channel, channel),
        eq(verificationCodes.target, target),
        eq(verificationCodes.purpose, purpose),
        isNull(verificationCodes.consumedAt),
        gt(verificationCodes.expiresAt, now),
      ),
    )
    .orderBy(sql`id DESC`)
    .get();
  if (!row) return { ok: false, error: 'CODE_INVALID_OR_EXPIRED' };
  if (!codeMatches(row.codeHash, code)) return { ok: false, error: 'CODE_MISMATCH' };
  db.update(verificationCodes)
    .set({ consumedAt: now })
    .where(eq(verificationCodes.id, row.id))
    .run();
  return { ok: true };
}

/** 清理过期验证码（挂进 audit 的清理循环） */
function purgeExpiredCodes(now = Date.now()): void {
  getDb().delete(verificationCodes).where(sql`expires_at < ${now - 24 * 3600_000}`).run();
}

registerPurgeTask(purgeExpiredCodes);
