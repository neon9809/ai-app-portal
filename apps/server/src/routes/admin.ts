/**
 * 管理后台 API（E1）：用户管理、运行时安全策略（settings）、审计查询、
 * 首配向导总览（E2-②）、邀请码签发。
 */
import { Router } from 'express';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { getDb, getSqlite } from '../db/index.js';
import { apps, inviteCodes, localCredentials, sessions, users } from '../db/schema.js';
import { HttpError, h } from '../lib/httpError.js';
import { requireAdmin } from '../lib/auth.js';
import { publicUserOf } from './shared.js';
import { getEmailChannel, outboundMailConfigured } from '../lib/verification.js';
import { generatePassword, hashPassword } from '../lib/passwords.js';
import { listSettingsForAdmin, updateSettingFromAdmin, SETTING_DEFS, getSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
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
    getDb()
      .insert(localCredentials)
      .values({ userId: uid, passwordHash: await hashPassword(password), updatedAt: Date.now() })
      .run();
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
    const body = (req.body ?? {}) as { status?: string };
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
    getDb()
      .update(localCredentials)
      .set({ passwordHash: await hashPassword(password), updatedAt: Date.now() })
      .where(eq(localCredentials.userId, uid));
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
