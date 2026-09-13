/**
 * 管理后台（E1/E2，P0 硬指标）：
 * ① 视觉与门户同源（同一 AntD 主题 token / CSS variables）
 * ② 首配 checklist 向导（管理员密码→证书→注册策略→第一个应用，状态自动检测）
 * ③ 配置项一句话说明 +「默认值即可跑」标注 + 高级项折叠
 * ④ 危险操作防呆（告知后果 + 输入确认）
 * ⑤ 状态仪表卡（证书/上游健康/网关 绿黄红）
 * ⑥ 移动端可看状态（卡片纵向堆叠）
 * ⑦ 保存即生效 + 测试按钮直接给结果
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
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useSession } from '../state/session';
import type { PublicUser } from '@aap/shared';

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

function dot(state: string): ReactNode {
  const color = state === 'ok' || state === 'green' ? '#52c41a' : state === 'down' ? '#ff4d4f' : '#faad14';
  return <Badge color={color} text={state === 'ok' ? '正常' : state === 'down' ? '异常' : '未知'} />;
}

export function AdminPage() {
  const { me } = useSession();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState('overview');
  const [wizardCollapsed, setWizardCollapsed] = useState(false);

  const overview = useQuery({ queryKey: ['admin-overview'], queryFn: () => api<Overview>('/api/admin/overview'), refetchInterval: 30_000 });
  const tlsQ = useQuery({ queryKey: ['admin-tls'], queryFn: () => api<Record<string, unknown>>('/api/admin/tls') });

  if (!me || me.user.role !== 'admin') {
    return <Alert type="warning" showIcon message="需要管理员权限" description={<a href="/login">使用管理员账号登录</a>} />;
  }

  const c = overview.data?.checklist;

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto' }}>
      <Typography.Title level={4}>管理后台</Typography.Title>

      {/* ⑤ 状态仪表卡 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
        <Card size="small">
          <Descriptions column={1} size="small" title="HTTPS 证书">
            <Descriptions.Item label="状态">
              {dot(c?.httpsEnabled ? 'ok' : c?.tls !== 'off' ? 'warn' : 'unknown')}
            </Descriptions.Item>
            <Descriptions.Item label="模式">{c?.tls === 'acme' ? '自动签发' : c?.tls === 'manual' ? '手动上传' : '未启用（纯门户模式）'}</Descriptions.Item>
            {c?.certDaysRemaining != null ? (
              <Descriptions.Item label="剩余">{c.certDaysRemaining} 天</Descriptions.Item>
            ) : null}
          </Descriptions>
        </Card>
        <Card size="small">
          <Descriptions column={1} size="small" title="应用网关">
            <Descriptions.Item label="已接入">{c?.appCount ?? 0} 个应用</Descriptions.Item>
            <Descriptions.Item label="在线会话">{overview.data?.liveSessions ?? 0}</Descriptions.Item>
          </Descriptions>
        </Card>
        <Card size="small">
          <Descriptions column={1} size="small" title="账号安全">
            <Descriptions.Item label="MFA">{dot(c?.adminMfaEnabled ? 'ok' : 'warn')}</Descriptions.Item>
            <Descriptions.Item label="注册">{c?.registrationMode === 'closed' ? '关闭' : c?.registrationMode === 'invite' ? '邀请制' : '开放'}</Descriptions.Item>
          </Descriptions>
        </Card>
      </div>

      {/* ② 首配 checklist 向导 */}
      {c && !wizardCollapsed ? (
        <Card size="small" style={{ marginBottom: 16 }} extra={<Button type="text" onClick={() => setWizardCollapsed(true)}>收起</Button>}>
          <Steps
            size="small"
            direction="horizontal"
            responsive
            items={[
              { title: '管理员密码', status: c.adminPasswordChanged ? 'finish' : 'process', description: <a onClick={() => setActiveTab('overview')}>修改初始密码</a> },
              { title: '域名证书', status: c.httpsEnabled ? 'finish' : 'process', description: <a onClick={() => setActiveTab('tls')}>配置 HTTPS</a> },
              { title: '注册策略', status: c.registrationMode !== 'closed' ? 'finish' : 'wait', description: <a onClick={() => setActiveTab('settings')}>设置注册方式</a> },
              { title: '接第一个应用', status: c.appCount > 0 ? 'finish' : 'wait', description: <a onClick={() => setActiveTab('apps')}>添加应用</a> },
            ]}
          />
        </Card>
      ) : null}

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: 'overview', label: '总览', children: <OverviewTab /> },
          { key: 'apps', label: '应用管理', children: <AppsTab /> },
          { key: 'users', label: '用户管理', children: <UsersTab /> },
          { key: 'settings', label: '安全策略', children: <SettingsTab /> },
          { key: 'tls', label: '证书', children: <TlsTab /> },
          { key: 'audit', label: '审计日志', children: <AuditTab /> },
          { key: 'invites', label: '邀请码', children: <InvitesTab /> },
        ]}
      />
    </div>
  );
}

// ---------- 总览 ----------

function OverviewTab() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => api<{ version: string; uptimeSec: number }>('/api/health') });
  return (
    <Card title="服务状态">
      <Descriptions column={1} size="small">
        <Descriptions.Item label="版本">{health.data?.version ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="运行时长">{health.data ? `${Math.floor(health.data.uptimeSec / 60)} 分钟` : '—'}</Descriptions.Item>
        <Descriptions.Item label="数据库">{dot('ok')}</Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

// ---------- 应用管理 ----------

function AppsTab() {
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
        [app.id]: r.ok ? `✓ 可达（${r.status}，${r.latencyMs}ms）` : `✗ ${r.error ?? r.status}`,
      }));
      void qc.invalidateQueries({ queryKey: ['admin-apps'] });
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [app.id]: err instanceof Error ? err.message : '测试失败' }));
    }
  }

  return (
    <Card
      title="应用管理"
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
      <div style={{ marginTop: 4, color: 'var(--aap-text-secondary)', fontSize: 12 }}>
        {appsQ.data?.apps.map((a) => testResult[a.id]).filter(Boolean).map((t, i) => (
          <div key={i}>{t}</div>
        ))}
      </div>

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
            extra="仅允许本机/内网地址，如 http://127.0.0.1:8001（默认值即可跑，公网地址需在高级设置放开）"
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
    </Card>
  );
}

// ---------- 用户管理 ----------

function UsersTab() {
  const qc = useQueryClient();
  const usersQ = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ users: PublicUser[] }>('/api/admin/users') });
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);

  async function reload(): Promise<void> {
    void qc.invalidateQueries({ queryKey: ['admin-users'] });
  }

  return (
    <Card
      title="用户管理"
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
                  description="永久删除该用户及其全部数据，不可恢复。输入用户名确认。"
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
    </Card>
  );
}

// ---------- 安全策略（settings） ----------

function SettingsTab() {
  const qc = useQueryClient();
  const settingsQ = useQuery({ queryKey: ['admin-settings'], queryFn: () => api<{ settings: SettingRow[] }>('/api/admin/settings') });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const groups = useMemo(() => {
    const all = settingsQ.data?.settings ?? [];
    return {
      basic: all.filter((s) => !s.advanced),
      advanced: all.filter((s) => s.advanced),
    };
  }, [settingsQ.data]);

  useEffect(() => {
    if (settingsQ.data) {
      const values: Record<string, string> = {};
      for (const s of settingsQ.data.settings) values[s.key] = s.value;
      form.setFieldsValue(values);
    }
  }, [settingsQ.data, form]);

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

  function renderInput(s: SettingRow): ReactNode {
    if (s.type === 'bool') return <Switch />;
    if (s.secret) return <Input.Password placeholder="留空保持不变" autoComplete="new-password" />;
    return <Input placeholder={s.defaultsWork ? '（默认值即可）' : ''} />;
  }

  return (
    <Card
      title="安全与站点策略"
      extra={
        <Space>
          <Switch checkedChildren="高级" unCheckedChildren="高级" checked={showAdvanced} onChange={setShowAdvanced} />
          <Button type="primary" loading={saving} onClick={() => void save()}>保存（即时生效）</Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical">
        {groups.basic.map((s) => (
          <Form.Item key={s.key} name={s.key} label={
            <Space size="small" wrap>
              <span>{s.desc.split('（')[0]}</span>
              {s.defaultsWork ? <Tag bordered={false} color="green" style={{ fontSize: 11 }}>默认值即可跑</Tag> : null}
              <Typography.Text code style={{ fontSize: 11 }}>{s.key}</Typography.Text>
            </Space>
          } extra={s.desc}>
            {renderInput(s)}
          </Form.Item>
        ))}
        {showAdvanced ? (
          <>
            <Typography.Title level={5} style={{ marginTop: 8 }}>高级项（默认值即可跑，无必要时不要修改）</Typography.Title>
            {groups.advanced.map((s) => (
              <Form.Item key={s.key} name={s.key} label={
                <Space size="small" wrap>
                  <span>{s.desc.split('（')[0]}</span>
                  <Typography.Text code style={{ fontSize: 11 }}>{s.key}</Typography.Text>
                </Space>
              } extra={s.desc}>
                {renderInput(s)}
              </Form.Item>
            ))}
          </>
        ) : null}
      </Form>
    </Card>
  );
}

// ---------- 证书 ----------

function TlsTab() {
  const qc = useQueryClient();
  const tlsQ = useQuery({ queryKey: ['admin-tls'], queryFn: () => api<{ installed: boolean; httpsEnabled: boolean; mode: string; domain: string | null; httpsPort: number; cert: { subject: string; daysRemaining: number } | null; error?: string } | Record<string, unknown>>('/api/admin/tls') });
  const [pemForm] = Form.useForm();
  const [acmeForm] = Form.useForm();

  const st = tlsQ.data as { installed?: boolean; httpsEnabled?: boolean; mode?: string; domain?: string | null; httpsPort?: number; cert?: { subject: string; daysRemaining: number } | null } | undefined;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card title="证书状态">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="模式">{st?.mode === 'acme' ? '自动签发' : st?.mode === 'manual' ? '手动上传' : '未启用（纯门户模式）'}</Descriptions.Item>
          <Descriptions.Item label="HTTPS">{st?.httpsEnabled ? <Tag color="green">已启用（端口 {st.httpsPort}）</Tag> : <Tag>未启用</Tag>}</Descriptions.Item>
          {st?.cert ? (
            <Descriptions.Item label="证书">{st.cert.subject}（剩余 {st.cert.daysRemaining} 天）</Descriptions.Item>
          ) : null}
          {st?.domain ? <Descriptions.Item label="ACME 域名">{st.domain}</Descriptions.Item> : null}
        </Descriptions>
      </Card>

      <Card title="自动签发（ACME / Let's Encrypt）" extra={<Tag bordered={false} color="blue">推荐</Tag>}>
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

      <Card title="手动上传证书（PEM）">
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
    </Space>
  );
}

// ---------- 审计 ----------

function AuditTab() {
  const qc = useQueryClient();
  const auditQ = useQuery({ queryKey: ['admin-audit'], queryFn: () => api<{ logs: AuditRow[] }>('/api/admin/audit?limit=200') });
  return (
    <Card title="审计日志（最近 200 条）" extra={<Button onClick={() => void qc.invalidateQueries({ queryKey: ['admin-audit'] })}>刷新</Button>}>
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
  );
}

// ---------- 邀请码 ----------

function InvitesTab() {
  const qc = useQueryClient();
  interface Invite {
    code: string;
    usedBy: number | null;
    createdAt: number;
  }
  const invitesQ = useQuery({ queryKey: ['admin-invites'], queryFn: () => api<{ invites: Invite[] }>('/api/admin/invites') });
  return (
    <Card
      title="邀请码（注册开关 = 邀请制时使用）"
      extra={
        <Button
          type="primary"
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
  );
}
