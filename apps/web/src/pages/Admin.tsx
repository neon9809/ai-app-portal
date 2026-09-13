/**
 * 管理后台（E1/E2，P0 硬指标）——目录与功能域一一对应：
 *   总览（仪表卡 + 快捷入口 + 最近动态）
 *   站点设置（品牌/默认主题/备案）
 *   应用管理（应用列表 + 网关限流）
 *   用户与注册（用户列表 + 注册策略 + 邀请码）
 *   安全（防爆破/PoW/会话/签名密钥/Turnstile + 审计日志）
 *   通知通道（邮件 [SMTP/Resend] / 未来短信 + 发信测试）
 *   证书（状态/ACME/PEM/HTTPS 跳转）
 * E2 七条：①同源主题 ②首配向导（左侧竖向） ③一句话说明+默认值标注+高级折叠
 * ④危险操作防呆 ⑤状态仪表卡 ⑥移动端可看状态 ⑦保存即生效+测试按钮
 */
import type { ReactNode } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Steps,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useSession } from '../state/session';
import type { PublicUser } from '@aap/shared';

// ---------- 类型 ----------

interface AdminApp {
  id: string;
  name: string;
  description: string;
  category: string;
  visibility: 'public' | 'login' | 'member';
  passUser: boolean;
  upstream: string;
  hasUrlSecret: boolean;
  enabled: boolean;
  sort: number;
  healthState: 'ok' | 'down' | 'unknown';
  lastProbeAt: number | null;
}
interface SettingRow {
  key: string;
  value: string;
  type: 'string' | 'int' | 'bool';
  group: string;
  options?: string[];
  desc: string;
  secret: boolean;
  advanced: boolean;
  defaultsWork: boolean;
}
interface Overview {
  checklist: {
    adminPasswordChanged: boolean;
    adminMfaEnabled: boolean;
    tls: 'off' | 'manual' | 'acme';
    httpsEnabled: boolean;
    certDaysRemaining: number | null;
    registrationMode: string;
    appCount: number;
  };
  liveSessions: number;
}
interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  ip: string | null;
  action: string;
  detail: unknown;
}
interface Invite {
  code: string;
  usedBy: number | null;
  createdAt: number;
}

function dot(state: string): ReactNode {
  const color = state === 'ok' || state === 'green' ? '#52c41a' : state === 'down' ? '#ff4d4f' : '#faad14';
  const label = state === 'ok' || state === 'green' ? '正常' : state === 'down' ? '异常' : '未知';
  return <Badge color={color} text={label} />;
}

// ---------- 通用：分组配置表单（③一句话说明 + 默认值标注；⑦保存即生效） ----------

function SettingsForm({ groups, excludeKeys = [] }: { groups: string[]; excludeKeys?: string[] }): ReactNode {
  const qc = useQueryClient();
  const settingsQ = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => api<{ settings: SettingRow[] }>('/api/admin/settings'),
  });
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settingsQ.data) {
      const values: Record<string, string> = {};
      for (const s of settingsQ.data.settings) values[s.key] = s.value;
      form.setFieldsValue(values);
    }
  }, [settingsQ.data, form]);

  const ordered: Array<[string, SettingRow[]]> = groups.map((g) => [
    g,
    (settingsQ.data?.settings ?? []).filter((s) => s.group === g && !excludeKeys.includes(s.key)),
  ]);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const values = form.getFieldsValue() as Record<string, string | boolean>;
      const payload: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) {
        if (v === undefined || v === null) continue;
        payload[k] = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
      }
      await api('/api/admin/settings', { method: 'PUT', json: payload });
      message.success('已保存并即时生效');
      void qc.invalidateQueries({ queryKey: ['admin-settings'] });
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  function renderItem(s: SettingRow): ReactNode {
    return (
      <Form.Item
        key={s.key}
        name={s.key}
        label={
          <Space size="small" wrap>
            <span>{s.desc.split('（')[0]}</span>
            {s.defaultsWork ? <Tag bordered={false} color="green" style={{ fontSize: 11 }}>默认值即可跑</Tag> : null}
            <Typography.Text code style={{ fontSize: 11 }}>{s.key}</Typography.Text>
          </Space>
        }
        extra={s.desc}
        valuePropName={s.type === 'bool' ? 'checked' : 'value'}
      >
        {s.type === 'bool' ? (
          <Switch />
        ) : s.options ? (
          <Select options={s.options.map((o) => ({ value: o, label: o }))} />
        ) : s.secret ? (
          <Input.Password placeholder="留空保持不变" autoComplete="new-password" />
        ) : (
          <Input placeholder={s.defaultsWork ? '（默认值即可）' : ''} />
        )}
      </Form.Item>
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {ordered.map(([g, items]) =>
        items.length > 0 ? (
          <Card key={g} size="small" title={g} extra={<Tag bordered={false} style={{ fontSize: 11 }}>{items.length} 项</Tag>}>
            {items.map(renderItem)}
          </Card>
        ) : null,
      )}
      <Button type="primary" loading={saving} onClick={() => void save()}>
        保存（即时生效）
      </Button>
    </Space>
  );
}

// ---------- 主页面 ----------

export function AdminPage() {
  const { me } = useSession();
  const [activeTab, setActiveTab] = useState('overview');
  const [railCollapsed, setRailCollapsed] = useState(() => localStorage.getItem('aap.admin.railCollapsed') === '1');

  const overview = useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => api<Overview>('/api/admin/overview'),
    refetchInterval: 30_000,
  });
  const c = overview.data?.checklist;

  // 首配向导（左侧竖向）：跳过/完成状态持久化
  const [skipCert, setSkipCert] = useState(() => localStorage.getItem('aap.wizard.skipCert') === '1');
  const [skipReg, setSkipReg] = useState(() => localStorage.getItem('aap.wizard.skipReg') === '1');
  const markSkip = (k: 'cert' | 'reg'): void => {
    localStorage.setItem(`aap.wizard.skip${k === 'cert' ? 'Cert' : 'Reg'}`, '1');
    if (k === 'cert') setSkipCert(true);
    else setSkipReg(true);
  };
  const wizardDone = Boolean(
    c &&
      c.adminPasswordChanged &&
      c.adminMfaEnabled &&
      (c.httpsEnabled || skipCert) &&
      c.appCount > 0 &&
      (c.registrationMode !== 'closed' || skipReg),
  );
  const showRail = !railCollapsed && !wizardDone;

  if (!me || me.user.role !== 'admin') {
    return <Alert type="warning" showIcon message="需要管理员权限" description={<a href="/login">使用管理员账号登录</a>} />;
  }

  const go = (tab: string) => () => setActiveTab(tab);

  return (
    <div style={{ maxWidth: 1160, margin: '0 auto' }}>
      <Typography.Title level={4}>管理后台</Typography.Title>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        {/* ② 首配向导：左侧竖向，占位小；完成后自动隐藏 */}
        {showRail && c ? (
          <Card
            size="small"
            style={{ width: 250, flexShrink: 0, position: 'sticky', top: 76 }}
            title="首次配置"
            extra={
              <Button
                type="text"
                size="small"
                onClick={() => {
                  localStorage.setItem('aap.admin.railCollapsed', '1');
                  setRailCollapsed(true);
                }}
              >
                收起
              </Button>
            }
          >
            <Steps
              direction="vertical"
              size="small"
              current={-1}
              items={[
                {
                  title: '管理员密码',
                  status: c.adminPasswordChanged ? 'finish' : 'process',
                  description: <a href="/account">去修改</a>,
                },
                {
                  title: '绑定 MFA',
                  status: c.adminMfaEnabled ? 'finish' : 'process',
                  description: <a href="/mfa-setup">去绑定</a>,
                },
                {
                  title: '域名证书',
                  status: c.httpsEnabled ? 'finish' : skipCert ? 'finish' : 'wait',
                  description: (
                    <>
                      <a onClick={go('tls')}>去配置</a>
                      {!c.httpsEnabled ? <> · <a onClick={() => markSkip('cert')}>跳过（内网）</a></> : null}
                    </>
                  ),
                },
                {
                  title: '注册策略',
                  status: c.registrationMode !== 'closed' ? 'finish' : skipReg ? 'finish' : 'wait',
                  description: (
                    <>
                      <a onClick={go('users')}>去设置</a>
                      {c.registrationMode === 'closed' ? <> · <a onClick={() => markSkip('reg')}>保持关闭</a></> : null}
                    </>
                  ),
                },
                {
                  title: '接第一个应用',
                  status: c.appCount > 0 ? 'finish' : 'process',
                  description: <a onClick={go('apps')}>去接入</a>,
                },
              ]}
            />
          </Card>
        ) : null}

        <div style={{ flex: 1, minWidth: 300 }}>
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            items={[
              { key: 'overview', label: '总览', children: <OverviewTab onShowRail={() => { localStorage.removeItem('aap.admin.railCollapsed'); setRailCollapsed(false); }} onGoTab={(t) => setActiveTab(t)} /> },
              { key: 'site', label: '站点设置', children: <SettingsForm groups={['站点与品牌']} /> },
              { key: 'apps', label: '应用管理', children: <AppsTab /> },
              { key: 'users', label: '用户与注册', children: <UsersRegTab /> },
              { key: 'security', label: '安全', children: <SecurityTab /> },
              { key: 'mail', label: '通知通道', children: <MailTab /> },
              { key: 'tls', label: '证书', children: <TlsTab /> },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

// ---------- 总览（仪表卡 + 快捷入口 + 最近动态） ----------

function OverviewTab({ onShowRail, onGoTab }: { onShowRail: () => void; onGoTab: (tab: string) => void }): ReactNode {
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: ['admin-overview'], queryFn: () => api<Overview>('/api/admin/overview'), refetchInterval: 30_000 });
  const health = useQuery({ queryKey: ['health'], queryFn: () => api<{ version: string; uptimeSec: number }>('/api/health') });
  const appsQ = useQuery({ queryKey: ['admin-apps'], queryFn: () => api<{ apps: AdminApp[] }>('/api/admin/apps') });
  const auditQ = useQuery({ queryKey: ['admin-audit-recent'], queryFn: () => api<{ logs: AuditRow[] }>('/api/admin/audit?limit=6') });

  const c = overview.data?.checklist;
  const apps = appsQ.data?.apps ?? [];
  const okApps = apps.filter((a) => a.healthState === 'ok').length;
  const downApps = apps.filter((a) => a.healthState === 'down').length;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {/* ⑤ 状态仪表卡 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
        <Card size="small">
          <Descriptions column={1} size="small" title="HTTPS 证书">
            <Descriptions.Item label="状态">{dot(c?.httpsEnabled ? 'ok' : 'unknown')}</Descriptions.Item>
            <Descriptions.Item label="模式">{c?.tls === 'acme' ? '自动签发' : c?.tls === 'manual' ? '手动上传' : '未启用'}</Descriptions.Item>
            {c?.certDaysRemaining != null ? <Descriptions.Item label="剩余">{c.certDaysRemaining} 天</Descriptions.Item> : null}
          </Descriptions>
        </Card>
        <Card size="small">
          <Descriptions column={1} size="small" title="应用网关">
            <Descriptions.Item label="已接入">{apps.length} 个</Descriptions.Item>
            <Descriptions.Item label="健康">{okApps} 正常{downApps > 0 ? ` / ${downApps} 异常` : ''}</Descriptions.Item>
          </Descriptions>
        </Card>
        <Card size="small">
          <Descriptions column={1} size="small" title="会话与账号">
            <Descriptions.Item label="在线会话">{overview.data?.liveSessions ?? 0}</Descriptions.Item>
            <Descriptions.Item label="管理员 MFA">{dot(c?.adminMfaEnabled ? 'ok' : 'unknown')}</Descriptions.Item>
          </Descriptions>
        </Card>
        <Card size="small">
          <Descriptions column={1} size="small" title="服务">
            <Descriptions.Item label="版本">{health.data?.version ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="运行时长">
              {health.data ? `${Math.floor(health.data.uptimeSec / 3600)}h ${Math.floor((health.data.uptimeSec % 3600) / 60)}m` : '—'}
            </Descriptions.Item>
          </Descriptions>
        </Card>
      </div>

      {/* 快捷入口 */}
      <Card size="small" title="快捷操作">
        <Space wrap>
          <Button onClick={() => onGoTab('apps')}>接第一个应用</Button>
          <Button onClick={() => onGoTab('tls')}>配置证书</Button>
          <Button onClick={() => onGoTab('users')}>注册策略</Button>
          <Button type="text" onClick={onShowRail}>显示首配向导</Button>
        </Space>
      </Card>

      {/* 最近动态 */}
      <Card size="small" title="最近动态">
        {auditQ.data?.logs.length ? (
          auditQ.data.logs.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: 10, fontSize: 12.5, padding: '3px 0' }}>
              <span style={{ color: 'var(--aap-text-secondary)', minWidth: 130 }}>{new Date(r.ts).toLocaleString()}</span>
              <Typography.Text code style={{ fontSize: 12 }}>{r.action}</Typography.Text>
              <span style={{ color: 'var(--aap-text-secondary)' }}>{r.actor}</span>
            </div>
          ))
        ) : (
          <Typography.Text type="secondary">暂无事件</Typography.Text>
        )}
        <div style={{ marginTop: 8 }}>
          <Button size="small" type="text" onClick={() => void qc.invalidateQueries({ queryKey: ['admin-audit-recent'] })}>
            刷新
          </Button>
        </div>
      </Card>
    </Space>
  );
}

// ---------- 应用管理（应用列表 + 网关限流配置） ----------

function AppsTab(): ReactNode {
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<AdminApp | null>(null);
  const [creating, setCreating] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const appsQ = useQuery({ queryKey: ['admin-apps'], queryFn: () => api<{ apps: AdminApp[] }>('/api/admin/apps') });

  async function save(values: Record<string, unknown>): Promise<void> {
    try {
      if (editing) {
        await api(`/api/admin/apps/${editing.id}`, { method: 'PUT', json: values });
        message.success('已保存并生效');
      } else {
        await api('/api/admin/apps', { method: 'POST', json: values });
        message.success('应用已接入并生效');
      }
      setEditing(null);
      setCreating(false);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['admin-apps'] });
      void qc.invalidateQueries({ queryKey: ['apps'] });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    }
  }

  async function testApp(app: AdminApp): Promise<void> {
    setTestResult((r) => ({ ...r, [app.id]: '测试中…' }));
    try {
      const r = await api<{ ok: boolean; status?: number; latencyMs?: number; error?: string }>(
        `/api/admin/apps/${app.id}/test`,
        { method: 'POST' },
      );
      setTestResult((prev) => ({
        ...prev,
        [app.id]: r.ok ? `✓ ${app.id} 可达（${r.status}，${r.latencyMs}ms）` : `✗ ${app.id}：${r.error ?? r.status}`,
      }));
      void qc.invalidateQueries({ queryKey: ['admin-apps'] });
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [app.id]: err instanceof Error ? err.message : '测试失败' }));
    }
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title="应用列表"
        extra={<Button type="primary" onClick={() => { setEditing(null); setCreating(true); form.resetFields(); }}>接入应用</Button>}
      >
        <Table<AdminApp>
          rowKey="id"
          dataSource={appsQ.data?.apps ?? []}
          pagination={false}
          size="small"
          columns={[
            { title: 'ID', dataIndex: 'id', width: 110 },
            { title: '名称', dataIndex: 'name', width: 130 },
            { title: '上游', dataIndex: 'upstream', ellipsis: true },
            {
              title: '策略',
              width: 90,
              render: (_, r) => (
                <Tag>{r.visibility === 'public' ? '公开' : r.visibility === 'member' ? '会员' : '登录'}</Tag>
              ),
            },
            { title: '健康', width: 90, render: (_, r) => dot(r.healthState) },
            {
              title: '操作',
              width: 230,
              render: (_, r) => (
                <Space size="small">
                  <Button size="small" onClick={() => void testApp(r)}>测试</Button>
                  <Button
                    size="small"
                    onClick={() => {
                      setEditing(r);
                      setCreating(true);
                      form.setFieldsValue({ ...r, urlSecret: undefined });
                    }}
                  >
                    编辑
                  </Button>
                  <Popconfirm
                    title={`删除应用「${r.name}」？`}
                    description="门户将立即无法访问该应用。"
                    onConfirm={async () => {
                      await api(`/api/admin/apps/${r.id}`, { method: 'DELETE' });
                      message.success('已删除');
                      void qc.invalidateQueries({ queryKey: ['admin-apps'] });
                      void qc.invalidateQueries({ queryKey: ['apps'] });
                    }}
                  >
                    <Button size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
        {Object.entries(testResult).filter(([, v]) => v).map(([k, v]) => (
          <div key={k} style={{ color: 'var(--aap-text-secondary)', fontSize: 12, marginTop: 4 }}>{v}</div>
        ))}
      </Card>

      <Card size="small" title="网关限流与超时" extra={<Tag bordered={false} color="green" style={{ fontSize: 11 }}>默认值即可跑</Tag>}>
        <SettingsForm groups={['应用网关']} />
      </Card>

      <Modal
        title={editing ? `编辑应用：${editing.name}` : '接入应用'}
        open={creating}
        onCancel={() => {
          setCreating(false);
          setEditing(null);
        }}
        footer={null}
        width={560}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={save}>
          {!editing ? (
            <Form.Item
              name="id"
              label="应用 ID（URL 前缀）"
              rules={[
                { required: true, message: '必填' },
                { pattern: /^[a-z0-9][a-z0-9-]*$/, message: '小写字母/数字/连字符' },
              ]}
              extra="访问地址为 https://你的域名/app/<ID>/"
            >
              <Input disabled={Boolean(editing)} placeholder="my-dify" />
            </Form.Item>
          ) : null}
          <Form.Item name="name" label="应用名称" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="Dify 聊天" />
          </Form.Item>
          <Form.Item name="description" label="描述" extra="显示在门户卡片上">
            <Input placeholder="一句话介绍" />
          </Form.Item>
          <Form.Item
            name="upstream"
            label="上游地址"
            rules={[{ required: true, message: '必填' }]}
            extra="仅允许本机/内网地址，如 http://127.0.0.1:8001（公网地址需在高级设置放开）"
          >
            <Input placeholder="http://127.0.0.1:8001" />
          </Form.Item>
          <Form.Item name="visibility" label="访问策略" initialValue="login" extra="公开=无需登录；需登录；会员=M3 上线">
            <Select
              options={[
                { value: 'public', label: '公开（免登录）' },
                { value: 'login', label: '需登录' },
                { value: 'member', label: '仅会员' },
              ]}
            />
          </Form.Item>
          <Form.Item name="passUser" label="注入用户身份" valuePropName="checked" extra="向应用转发 X-AAP-Identity 签名头（自研应用识别登录用户用）">
            <Switch />
          </Form.Item>
          <Form.Item
            name="urlSecret"
            label="上游凭据（可选）"
            extra='查询参数型如 "token=xxx"；路径即凭据型（Dify）填 "__path__=/chat/xxx"。保存后加密存储、不下发浏览器'
          >
            <Input placeholder="token=xxx 或 __path__=/chat/xxx" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            {editing ? '保存（即时生效）' : '接入'}
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}

// ---------- 用户与注册（用户列表 + 注册策略 + 邀请码） ----------

function UsersRegTab(): ReactNode {
  const qc = useQueryClient();
  const usersQ = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ users: PublicUser[] }>('/api/admin/users') });
  const invitesQ = useQuery({ queryKey: ['admin-invites'], queryFn: () => api<{ invites: Invite[] }>('/api/admin/invites') });
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);

  async function reload(): Promise<void> {
    void qc.invalidateQueries({ queryKey: ['admin-users'] });
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title="用户列表"
        extra={<Button type="primary" onClick={() => { form.resetFields(); setCreating(true); }}>创建用户</Button>}
      >
        <Table<PublicUser>
          rowKey="id"
          dataSource={usersQ.data?.users ?? []}
          pagination={false}
          size="small"
          columns={[
            { title: '用户名', dataIndex: 'username' },
            { title: '昵称', dataIndex: 'name' },
            { title: '邮箱', dataIndex: 'email', ellipsis: true },
            {
              title: '角色',
              width: 90,
              render: (_, r) => (r.role === 'admin' ? <Tag color="gold">管理员</Tag> : <Tag>用户</Tag>),
            },
            {
              title: '状态',
              width: 90,
              render: (_, r) =>
                r.status === 'active' ? <Tag color="green">正常</Tag> : r.status === 'disabled' ? <Tag color="red">已禁用</Tag> : <Tag>注销中</Tag>,
            },
            {
              title: '操作',
              width: 220,
              render: (_, r) => (
                <Space size="small">
                  {r.status !== 'disabled' ? (
                    <Popconfirm
                      title={`禁用「${r.username}」？`}
                      description="该用户所有会话将被踢下线。"
                      onConfirm={async () => {
                        await api(`/api/admin/users/${r.id}`, { method: 'PUT', json: { status: 'disabled' } });
                        message.success('已禁用');
                        void reload();
                      }}
                    >
                      <Button size="small" danger>禁用</Button>
                    </Popconfirm>
                  ) : (
                    <Button
                      size="small"
                      onClick={async () => {
                        await api(`/api/admin/users/${r.id}`, { method: 'PUT', json: { status: 'active' } });
                        message.success('已启用');
                        void reload();
                      }}
                    >
                      启用
                    </Button>
                  )}
                  <Button
                    size="small"
                    onClick={async () => {
                      const r2 = await api<{ password: string | null }>(`/api/admin/users/${r.id}/reset-password`, { method: 'POST', json: {} });
                      setCreated({ username: r.username ?? '', password: r2.password ?? '' });
                    }}
                  >
                    重置密码
                  </Button>
                  <Popconfirm
                    title={`删除「${r.username}」？`}
                    description="永久删除该用户及其全部数据，不可恢复。"
                    onConfirm={async () => {
                      await api(`/api/admin/users/${r.id}`, { method: 'DELETE' });
                      message.success('已删除');
                      void reload();
                    }}
                  >
                    <Button size="small" danger type="text">删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card size="small" title="注册策略">
        <SettingsForm groups={['注册与账号']} />
      </Card>

      <Card
        size="small"
        title="邀请码（注册开关 = 邀请制时使用）"
        extra={
          <Button
            onClick={async () => {
              await api('/api/admin/invites', { method: 'POST', json: { count: 5 } });
              message.success('已生成 5 枚');
              void qc.invalidateQueries({ queryKey: ['admin-invites'] });
            }}
          >
            生成 5 枚
          </Button>
        }
      >
        <Table<Invite>
          rowKey="code"
          size="small"
          dataSource={invitesQ.data?.invites ?? []}
          pagination={false}
          columns={[
            { title: '邀请码', dataIndex: 'code', render: (v: string) => <Typography.Text copyable code>{v}</Typography.Text> },
            { title: '状态', width: 120, render: (_, r) => (r.usedBy ? <Tag>已使用</Tag> : <Tag color="green">可用</Tag>) },
            { title: '创建时间', width: 180, render: (_, r) => new Date(r.createdAt).toLocaleString() },
          ]}
        />
      </Card>

      <Modal title="创建用户" open={creating} onCancel={() => setCreating(false)} footer={null} destroyOnClose>
        <Form form={form} layout="vertical" onFinish={async (v) => {
          try {
            const r = await api<{ id: number; initialPassword: string | null }>('/api/admin/users', { method: 'POST', json: v });
            setCreating(false);
            setCreated({ username: v.username, password: r.initialPassword ?? '' });
            void reload();
          } catch (err) {
            message.error(err instanceof Error ? err.message : '创建失败');
          }
        }}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true }, { pattern: /^[a-z0-9][a-z0-9_.-]{2,63}$/, message: '3-64 位小写字母/数字/_.-' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="name" label="昵称">
            <Input />
          </Form.Item>
          <Form.Item name="password" label="初始密码" extra="留空自动生成；用户首次登录会强制改密">
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>创建</Button>
        </Form>
      </Modal>

      <Modal
        title="初始密码（仅显示一次）"
        open={Boolean(created)}
        onCancel={() => setCreated(null)}
        footer={<Button type="primary" onClick={() => setCreated(null)}>我已保存</Button>}
      >
        <Descriptions column={1}>
          <Descriptions.Item label="用户名">{created?.username}</Descriptions.Item>
          <Descriptions.Item label="密码">
            <Input readOnly value={created?.password} style={{ fontFamily: 'monospace' }} />
          </Descriptions.Item>
        </Descriptions>
      </Modal>
    </Space>
  );
}

// ---------- 安全（防爆破/PoW/会话/密钥/Turnstile + 审计日志） ----------

function SecurityTab(): ReactNode {
  const qc = useQueryClient();
  const auditQ = useQuery({ queryKey: ['admin-audit'], queryFn: () => api<{ logs: AuditRow[] }>('/api/admin/audit?limit=200') });
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title="安全策略">
        <SettingsForm groups={['安全与限流', '人机验证']} />
      </Card>
      <Card
        size="small"
        title="审计日志（最近 200 条）"
        extra={<Button size="small" onClick={() => void qc.invalidateQueries({ queryKey: ['admin-audit'] })}>刷新</Button>}
      >
        <Table<AuditRow>
          rowKey="id"
          size="small"
          dataSource={auditQ.data?.logs ?? []}
          pagination={{ pageSize: 50 }}
          columns={[
            { title: '时间', width: 160, render: (_, r) => new Date(r.ts).toLocaleString() },
            { title: '操作者', dataIndex: 'actor', width: 140, ellipsis: true },
            { title: '事件', dataIndex: 'action', width: 180 },
            { title: 'IP', dataIndex: 'ip', width: 130 },
            {
              title: '明细',
              ellipsis: true,
              render: (_, r) => (
                <Typography.Text code style={{ fontSize: 11 }}>
                  {r.detail ? JSON.stringify(r.detail) : '—'}
                </Typography.Text>
              ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}

// ---------- 通知通道（邮件 [SMTP/Resend] / 未来短信 + 发信测试） ----------

function MailTab(): ReactNode {
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function sendTest(): Promise<void> {
    setTesting(true);
    setResult(null);
    try {
      const r = await api<{ to: string }>('/api/admin/mail/test', { method: 'POST', json: { to: testTo || undefined } });
      setResult(`✓ 测试邮件已发送至 ${r.to}，请查收`);
    } catch (err) {
      setResult(`✗ ${err instanceof Error ? err.message : '发送失败'}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title="邮件发信（验证码用；短信通道后续版本接入）" extra={<Tag bordered={false} color="blue" style={{ fontSize: 11 }}>Resend 仅需 API Key</Tag>}>
        <SettingsForm groups={['通知通道（验证码发信）']} />
      </Card>
      <Card size="small" title="发信测试">
        <Space wrap>
          <Input
            style={{ width: 260 }}
            placeholder="收件邮箱（留空用管理员邮箱）"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
          />
          <Button type="primary" loading={testing} onClick={() => void sendTest()}>
            发送测试邮件
          </Button>
        </Space>
        {result ? (
          <div style={{ marginTop: 8, fontSize: 12.5 }}>{result}</div>
        ) : (
          <div style={{ marginTop: 8, color: 'var(--aap-text-secondary)', fontSize: 12 }}>
            未配置通道时验证码走服务端日志兜底（内网可离线）。
          </div>
        )}
      </Card>
    </Space>
  );
}

// ---------- 证书 ----------

function TlsTab(): ReactNode {
  const qc = useQueryClient();
  const tlsQ = useQuery({
    queryKey: ['admin-tls'],
    queryFn: () =>
      api<{
        installed: boolean;
        httpsEnabled: boolean;
        mode: string;
        domain: string | null;
        httpsPort: number;
        cert: { subject: string; daysRemaining: number } | null;
      }>('/api/admin/tls'),
  });
  const [pemForm] = Form.useForm();
  const [acmeForm] = Form.useForm();

  const st = tlsQ.data;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title="证书状态">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="模式">{st?.mode === 'acme' ? '自动签发' : st?.mode === 'manual' ? '手动上传' : '未启用（纯门户模式）'}</Descriptions.Item>
          <Descriptions.Item label="HTTPS">{st?.httpsEnabled ? <Tag color="green">已启用（端口 {st.httpsPort}）</Tag> : <Tag>未启用</Tag>}</Descriptions.Item>
          {st?.cert ? <Descriptions.Item label="证书">{st.cert.subject}（剩余 {st.cert.daysRemaining} 天）</Descriptions.Item> : null}
          {st?.domain ? <Descriptions.Item label="ACME 域名">{st.domain}</Descriptions.Item> : null}
        </Descriptions>
      </Card>

      <Card size="small" title="自动签发（ACME / Let's Encrypt）" extra={<Tag bordered={false} color="blue" style={{ fontSize: 11 }}>推荐</Tag>}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          要求：域名已解析到本机，且 80 端口可达（HTTP-01 验证）。内网 NAS 无公网 80 时请使用下方手动上传 PEM。
        </Typography.Paragraph>
        <Form form={acmeForm} layout="vertical" onFinish={async (v) => {
          try {
            await api('/api/admin/tls/acme', { method: 'POST', json: v });
            message.info('签发已启动，通常需要 10-60 秒，请稍后刷新状态');
            setTimeout(() => void qc.invalidateQueries({ queryKey: ['admin-tls'] }), 15_000);
          } catch (err) {
            message.error(err instanceof Error ? err.message : '启动失败');
          }
        }}>
          <Form.Item name="domain" label="域名" rules={[{ required: true, message: '请输入域名' }]}>
            <Input placeholder="nas.example.com" />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ required: true, message: '请输入邮箱' }, { type: 'email' }]}>
            <Input placeholder="you@example.com" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>开始签发</Button>
        </Form>
      </Card>

      <Card size="small" title="手动上传证书（PEM）">
        <Form form={pemForm} layout="vertical" onFinish={async (v) => {
          try {
            await api('/api/admin/tls', { method: 'PUT', json: v });
            message.success('证书已安装并热生效');
            pemForm.resetFields();
            void qc.invalidateQueries({ queryKey: ['admin-tls'] });
          } catch (err) {
            message.error(err instanceof Error ? err.message : '安装失败');
          }
        }}>
          <Form.Item name="cert" label="证书 PEM" rules={[{ required: true, message: '请粘贴证书' }]}>
            <Input.TextArea rows={4} placeholder="-----BEGIN CERTIFICATE-----" style={{ fontFamily: 'monospace' }} />
          </Form.Item>
          <Form.Item name="key" label="私钥 PEM" rules={[{ required: true, message: '请粘贴私钥' }]}>
            <Input.TextArea rows={4} placeholder="-----BEGIN PRIVATE KEY-----" style={{ fontFamily: 'monospace' }} />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">安装并生效</Button>
            <Popconfirm
              title="移除证书？"
              description="HTTPS 将立即停用，回到纯门户模式。"
              onConfirm={async () => {
                await api('/api/admin/tls', { method: 'DELETE' });
                message.success('已移除');
                void qc.invalidateQueries({ queryKey: ['admin-tls'] });
              }}
            >
              <Button danger>移除证书</Button>
            </Popconfirm>
          </Space>
        </Form>
      </Card>

      <Card size="small" title="HTTPS 跳转">
        <SettingsForm groups={['证书与 HTTPS']} excludeKeys={['ACME_DOMAIN', 'ACME_EMAIL', 'ACME_STAGING']} />
      </Card>
    </Space>
  );
}
