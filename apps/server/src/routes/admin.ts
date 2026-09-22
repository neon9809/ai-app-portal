/**
 * 管理后台 API（E1）：用户管理、运行时安全策略（settings）、审计查询、
 * 首配向导总览（E2-②）、邀请码签发。
 */
import { Router } from 'express';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { AAP_VERSION } from '@aap/shared';
import { getDb, getSqlite } from '../db/index.js';
import { apps, inviteCodes, sessions, trustedSigningKeys, users } from '../db/schema.js';
import { HttpError, h } from '../lib/httpError.js';
import { requireAdmin } from '../lib/auth.js';
import { publicUserOf } from './shared.js';
import { getEmailChannel, outboundMailConfigured } from '../lib/verification.js';
import { generatePassword } from '../lib/passwords.js';
import { writeLocalCredentials } from '../lib/bootstrap.js';
import { listSettingsForAdmin, updateSettingFromAdmin, SETTING_DEFS, getSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { stopAllPersistent } from '../lib/sandbox.js';
import { createGroup, deleteGroup, groupMemberIds, listGroups, setGroupMembers, updateGroup } from '../lib/groups.js';
import { status as tlsStatus } from '../gateway/tls.js';

export const adminRouter = Router();

adminRouter.use('/admin', requireAdmin);

// ---------- 用户管理 ----------

adminRouter.get(
  '/admin/users',
  h(async (_req, res) => {
    const rows = getDb().select().from(users).orderBy(sql`id`).all();
    res.json({ users: rows.map(publicUserOf) });
  }),
);

adminRouter.post(
  '/admin/users',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { username?: string; password?: string; role?: string; name?: string };
    const username = String(body.username ?? '').trim().toLowerCase();
    const password = String(body.password ?? '') || generatePassword(12);
    if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username)) {
      throw new HttpError(400, 'INVALID_USERNAME', '用户名需 3-64 位小写字母/数字/_.-');
    }
    if (password.length < 8 || password.length > 128) throw new HttpError(400, 'INVALID_PASSWORD', '密码长度需 8-128 位');
    if (getDb().select({ id: users.id }).from(users).where(eq(users.username, username)).get()) {
      throw new HttpError(409, 'USERNAME_TAKEN', '用户名已被占用');
    }
    const info = getDb()
      .insert(users)
      .values({
        kind: 'local',
        username,
        name: body.name?.trim() || username,
        role: body.role === 'admin' ? 'admin' : 'user',
        mustChangePassword: true,
        createdAt: Date.now(),
      })
      .run();
    const uid = Number(info.lastInsertRowid);
    await writeLocalCredentials(uid, password);
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.user.created', { uid, username });
    res.json({ ok: true, id: uid, initialPassword: password });
  }),
);

adminRouter.put(
  '/admin/users/:id',
  h(async (req, res) => {
    const uid = Number(req.params.id);
    const target = getDb().select().from(users).where(eq(users.id, uid)).get();
    if (!target) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    const body = (req.body ?? {}) as { status?: string; role?: string };

    // 角色变更（设为管理员/取消管理员）
    if (body.role !== undefined) {
      const role = body.role === 'admin' || body.role === 'user' ? body.role : null;
      if (!role) throw new HttpError(400, 'INVALID_ROLE', '角色必须是 admin/user');
      if (uid === req.user!.id) throw new HttpError(400, 'CANNOT_MODIFY_SELF_ROLE', '不能修改自己的角色（防自锁）');
      if (target.role === 'admin' && role === 'user') {
        const admins = getDb().select({ n: sql<number>`count(*)` }).from(users).where(eq(users.role, 'admin')).get()?.n ?? 0;
        if (admins <= 1) throw new HttpError(409, 'LAST_ADMIN', '至少保留一名管理员');
      }
      getDb().update(users).set({ role }).where(eq(users.id, uid)).run();
      // 角色每请求随会话装载读取，变更即时生效，无需踢会话
      audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.user.role', { uid, role });
    }

    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'disabled') {
        throw new HttpError(400, 'INVALID_STATUS', '状态必须是 active/disabled');
      }
      if (body.status === 'active' && target.status === 'pending_approval') {
        audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.user.approved', { userId: uid });
      }
      // 防自锁：不能禁用自己（参考实现 H 项）
      if (uid === req.user!.id) throw new HttpError(400, 'CANNOT_DISABLE_SELF', '不能禁用自己的账号');
      getDb().update(users).set({ status: body.status }).where(eq(users.id, uid)).run();
      if (body.status === 'disabled') {
        getDb().delete(sessions).where(eq(sessions.userId, uid)).run(); // 禁用即踢下线
      }
      audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.user.status', { uid, status: body.status });
    }
    res.json({ ok: true });
  }),
);

adminRouter.post(
  '/admin/users/:id/reset-password',
  h(async (req, res) => {
    const uid = Number(req.params.id);
    const target = getDb().select().from(users).where(eq(users.id, uid)).get();
    if (!target) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    const body = (req.body ?? {}) as { password?: string };
    const password = String(body.password ?? '') || generatePassword(12);
    if (password.length < 8 || password.length > 128) throw new HttpError(400, 'INVALID_PASSWORD', '密码长度需 8-128 位');
    // upsert：OIDC 用户没有本地凭据行，直接 UPDATE 会静默无效（下发的密码登录不上）
    await writeLocalCredentials(uid, password);
    getDb().update(users).set({ mustChangePassword: true }).where(eq(users.id, uid)).run();
    getDb().delete(sessions).where(eq(sessions.userId, uid)).run(); // 重置即全端踢下线
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.user.password_reset', { uid });
    res.json({ ok: true, password });
  }),
);

adminRouter.delete(
  '/admin/users/:id',
  h(async (req, res) => {
    const uid = Number(req.params.id);
    if (uid === req.user!.id) throw new HttpError(400, 'CANNOT_DELETE_SELF', '不能删除自己的账号');
    const target = getDb().select().from(users).where(eq(users.id, uid)).get();
    if (!target) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    getDb().delete(users).where(eq(users.id, uid)).run();
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.user.deleted', { uid });
    res.json({ ok: true });
  }),
);

// ---------- 运行时安全策略（settings；保存即生效） ----------

adminRouter.get(
  '/admin/settings',
  h(async (_req, res) => {
    res.json({
      settings: listSettingsForAdmin().map((s) => ({
        key: s.key,
        value: s.value,
        label: s.def.label,
        type: s.def.type,
        group: s.def.group,
        options: s.def.options,
        choiceLabels: s.def.choiceLabels,
        exclusiveOf: s.def.exclusiveOf,
        desc: s.def.desc,
        secret: Boolean(s.def.secret),
        advanced: Boolean(s.def.advanced),
        defaultsWork: s.def.defaultsWork !== false,
      })),
    });
  }),
);

adminRouter.put(
  '/admin/settings',
  h(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const keys = Object.keys(body);
    for (const key of keys) {
      if (!SETTING_DEFS[key]) throw new HttpError(400, 'UNKNOWN_SETTING', `未知配置项: ${key}`);
      updateSettingFromAdmin(key, String(body[key] ?? ''));
    }
    // 轮换身份签名密钥后，passUser 沙箱 env 里还是旧密钥（spawn 时定格）：
    // 全部停掉，下次访问以新密钥重新拉起
    if (keys.includes('AAP_SIGN_SECRET')) stopAllPersistent();
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'config.update', { keys });
    res.json({ ok: true });
  }),
);

/** 通知通道发信测试（邮件；短信未来接入） */
adminRouter.post(
  '/admin/mail/test',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { to?: string };
    const me = getDb().select().from(users).where(eq(users.id, req.user!.id)).get();
    const to = String(body.to ?? '').trim() || me?.email || getSetting('SMTP_FROM') || getSetting('RESEND_FROM') || '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new HttpError(400, 'NO_RECIPIENT', '没有可用收件邮箱：请填写收件地址，或先给管理员账号绑定邮箱');
    }
    if (!outboundMailConfigured()) {
      throw new HttpError(400, 'MAIL_NOT_CONFIGURED', '尚未配置发信通道（当前为日志兜底模式：验证码会打印到服务端日志）');
    }
    await getEmailChannel().send(to, '123456', 'bind');
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.mail.test', { to });
    res.json({ ok: true, to });
  }),
);

// ---------- 用户分组（会员等级/自定义组） ----------

adminRouter.get(
  '/admin/groups',
  h(async (_req, res) => {
    res.json({ groups: listGroups() });
  }),
);

adminRouter.post(
  '/admin/groups',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { name?: string; note?: string };
    if (!body.name?.trim()) throw new HttpError(400, 'INVALID_NAME', '分组名称必填');
    const id = createGroup(body.name, body.note ?? '');
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.group.create', { id, name: body.name });
    res.json({ ok: true, id });
  }),
);

adminRouter.put(
  '/admin/groups/:id',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { name?: string; note?: string; memberIds?: number[] };
    updateGroup(Number(req.params.id), body);
    if (body.memberIds !== undefined) setGroupMembers(Number(req.params.id), body.memberIds);
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.group.update', { id: Number(req.params.id) });
    res.json({ ok: true });
  }),
);

adminRouter.delete(
  '/admin/groups/:id',
  h(async (req, res) => {
    deleteGroup(Number(req.params.id));
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.group.delete', { id: Number(req.params.id) });
    res.json({ ok: true });
  }),
);

adminRouter.get(
  '/admin/groups/:id/members',
  h(async (req, res) => {
    res.json({ memberIds: groupMemberIds(Number(req.params.id)) });
  }),
);

/** 密钥查看（自研应用验签/接入需要；审计泄露面） */
adminRouter.get(
  '/admin/secrets/:key',
  h(async (req, res) => {
    const key = String(req.params.key);
    const def = SETTING_DEFS[key];
    if (!def || !def.secret) throw new HttpError(404, 'NOT_SECRET', '配置项不存在或不是密钥');
    const value = getSetting(key);
    if (!value) throw new HttpError(404, 'NOT_SET', '该密钥尚未生成');
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'config.secret.revealed', { key });
    res.json({ key, value });
  }),
);

// ---------- 审计查询 ----------

adminRouter.get(
  '/admin/audit',
  h(async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100));
    const rows = getSqlite()
      .prepare('SELECT id, ts, actor, ip, action, detail FROM audit_logs ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ id: number; ts: number; actor: string; ip: string | null; action: string; detail: string | null }>;
    res.json({
      logs: rows.map((r) => ({
        ...r,
        detail: r.detail ? (JSON.parse(r.detail) as unknown) : null,
      })),
    });
  }),
);

// ---------- 邀请码 ----------

adminRouter.get(
  '/admin/invites',
  h(async (_req, res) => {
    const rows = getDb().select().from(inviteCodes).orderBy(sql`created_at DESC`).limit(100).all();
    res.json({ invites: rows });
  }),
);

adminRouter.post(
  '/admin/invites',
  h(async (req, res) => {
    const body = (req.body ?? {}) as { note?: string; count?: number };
    const count = Math.min(20, Math.max(1, Number(body.count ?? 1) || 1));
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const code = randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})/, '$1-');
      getDb()
        .insert(inviteCodes)
        .values({ code, createdBy: req.user!.id, note: body.note ?? null, createdAt: Date.now() })
        .run();
      codes.push(code);
    }
    audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'admin.invites.created', { count });
    res.json({ codes });
  }),
);

// ---------- 包签名信任公钥（G4，Ed25519 信任链） ----------

adminRouter.get('/admin/signing-keys', h(async (_req, res) => {
  const keys = getDb().select().from(trustedSigningKeys).orderBy(sql`id`).all();
  res.json({ keys });
}));

adminRouter.post('/admin/signing-keys', h(async (req, res) => {
  const body = (req.body ?? {}) as { name?: string; publicKey?: string };
  let raw: Buffer;
  try {
    raw = Buffer.from(String(body.publicKey ?? ''), 'base64');
  } catch {
    throw new HttpError(400, 'INVALID_KEY', '公钥不是合法 base64');
  }
  if (raw.length !== 32) throw new HttpError(400, 'INVALID_KEY', 'Ed25519 公钥必须是 32 字节（base64）');
  const keyId = 'SHA256:' + createHash('sha256').update(raw).digest('hex').slice(0, 16);
  const dup = getDb()
    .select({ id: trustedSigningKeys.id })
    .from(trustedSigningKeys)
    .where(eq(trustedSigningKeys.keyId, keyId))
    .get();
  if (dup) throw new HttpError(409, 'KEY_EXISTS', '该公钥已在信任列表');
  const info = getDb()
    .insert(trustedSigningKeys)
    .values({
      keyId,
      name: String(body.name ?? '').trim().slice(0, 64),
      publicKey: raw.toString('base64'),
      builtin: false,
      createdAt: Date.now(),
    })
    .run();
  audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'signing_key.trusted', { keyId, name: body.name });
  res.json({ ok: true, id: Number(info.lastInsertRowid), keyId });
}));

adminRouter.delete('/admin/signing-keys/:id', h(async (req, res) => {
  const row = getDb()
    .select()
    .from(trustedSigningKeys)
    .where(eq(trustedSigningKeys.id, Number(req.params.id)))
    .get();
  if (!row) throw new HttpError(404, 'KEY_NOT_FOUND', '公钥不存在');
  if (row.builtin) throw new HttpError(400, 'BUILTIN_KEY', '内置信任公钥不可删除（可通过移除 AAP_OFFICIAL_SIGN_PUBKEY 环境变量并重建数据）');
  getDb().delete(trustedSigningKeys).where(eq(trustedSigningKeys.id, row.id)).run();
  audit(`${req.user!.kind}:${req.user!.id}`, req.clientIp ?? null, 'signing_key.removed', { keyId: row.keyId });
  res.json({ ok: true });
}));

// ---------- 首配向导总览（E2-② checklist 状态自动检测） ----------

adminRouter.get(
  '/admin/overview',
  h(async (req, res) => {
    const uid = req.user!.id;
    const me = getDb().select().from(users).where(eq(users.id, uid)).get();
    const admins = getDb().select().from(users).where(and(eq(users.role, 'admin'), eq(users.mustChangePassword, false))).all();
    const appCount = getDb().select({ n: sql<number>`count(*)` }).from(apps).get()?.n ?? 0;
    const liveSessions = getDb()
      .select({ n: sql<number>`count(*)` })
      .from(sessions)
      .where(gt(sessions.expiresAt, Date.now()))
      .get()?.n ?? 0;
    const recoveryUnused = me
      ? getDb()
          .select({ n: sql<number>`count(*)` })
          .from(inviteCodes)
          .where(isNull(inviteCodes.usedBy))
          .get()?.n ?? 0
      : 0;
    void recoveryUnused;

    res.json({
      version: getSqlite().prepare('SELECT 1').get() ? 'ok' : 'db-down',
      // 服务版本与运行时长仅管理员可见（匿名 /api/health 已收敛为仅 ok）
      releaseVersion: AAP_VERSION,
      uptimeSec: Math.round(process.uptime()),
      checklist: {
        adminPasswordChanged: admins.length > 0,
        adminMfaEnabled: Boolean(me?.mfaEnabled),
        tls: tlsStatus().mode,
        httpsEnabled: tlsStatus().httpsEnabled,
        certDaysRemaining: tlsStatus().cert?.daysRemaining ?? null,
        registrationMode: getSetting('REGISTRATION_MODE') ?? 'closed',
        appCount,
      },
      liveSessions,
    });
  }),
);
