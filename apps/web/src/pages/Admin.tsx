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
  ColorPicker,
  Descriptions,
  Form,
  Input,
  InputNumber,
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
import { CopyOutlined } from '@ant-design/icons';
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
  visibility: 'public' | 'login' | 'restricted' | 'private';
  passUser: boolean;
  upstream: string;
  kind: 'upstream' | 'html' | 'package';
  ownerUserId: number | null;
  hasUrlSecret: boolean;
  enabled: boolean;
  sort: number;
  healthState: 'ok' | 'down' | 'unknown';
  lastProbeAt: number | null;
  allowGroupIds: number[];
  allowUserIds: number[];
}
interface GroupRow {
  id: number;
  name: string;
  note: string;
  memberCount: number;
}
interface SettingRow {
  key: string;
  value: string;
  label: string;
  type: 'string' | 'int' | 'bool';
  group: string;
  options?: string[];
  choiceLabels?: Record<string, string>;
  exclusiveOf?: string;
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

  // 互斥（如 MAIL_PROVIDER=smtp|resend）：只显示选中方式的配置
  const provider = Form.useWatch('MAIL_PROVIDER', form) ?? (settingsQ.data?.settings.find((s) => s.key === 'MAIL_PROVIDER')?.value ?? 'smtp');
  const all = (settingsQ.data?.settings ?? []).filter((s) => {
    if (excludeKeys.includes(s.key)) return false;
    if (s.exclusiveOf === 'MAIL_PROVIDER') {
      return s.key.toUpperCase().startsWith(provider.toUpperCase());
    }
    return true;
  });

  const ordered: Array<[string, SettingRow[]]> = groups.map((g) => [
    g,
    all.filter((s) => s.group === g),
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
        label={s.label}
        tooltip={s.desc}
        valuePropName={s.type === 'bool' ? 'checked' : 'value'}
      >
        {renderControl(s, form)}
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

// ---------- 配置控件渲染（下拉/开关/取色/数字/密码+查看） ----------

const KEY_WIDGET: Record<string, string> = {
  THEME_ID: 'theme',
  ACCENT_COLOR: 'color',
  AAP_SIGN_SECRET: 'password',
  TURNSTILE_SECRET_KEY: 'password',
  SMTP_PASS: 'password',
  RESEND_API_KEY: 'password',
};

function renderControl(s: SettingRow, form?: { setFieldsValue: (v: Record<string, unknown>) => void }, secretReveal = false): ReactNode {
  if (s.key === 'THEME_ID' && s.choiceLabels) {
    return <Select options={Object.entries(s.choiceLabels).map(([value, label]) => ({ value, label }))} style={{ width: 220 }} />;
  }
  if (s.key === 'ACCENT_COLOR') {
    return (
      <Space.Compact style={{ width: '100%' }}>
        <ColorPicker
          value={s.value || undefined}
          onChange={(c) => form?.setFieldsValue({ ACCENT_COLOR: c.toHexString() })}
          showText
          disabledAlpha
        />
        <Input placeholder="留空用主题默认" style={{ width: 180 }} disabled />
      </Space.Compact>
    );
  }
  if (s.type === 'bool') return <Switch />;
  if (s.choiceLabels) {
    return <Select options={Object.entries(s.choiceLabels).map(([value, label]) => ({ value, label }))} />;
  }
  if (s.secret || KEY_WIDGET[s.key] === 'password') {
    const reveal = secretReveal ? (
      <Button
        onClick={() =>
          Modal.confirm({
            title: `查看密钥：${s.key}`,
            content: '查看操作会记入审计日志。确认继续？',
            okText: '查看',
            onOk: async () => {
              try {
                const r = await api<{ value: string }>(`/api/admin/secrets/${s.key}`);
                form?.setFieldsValue({ [s.key]: r.value });
                message.success('已填入表单（可复制）');
              } catch (err) {
                message.error(err instanceof Error ? err.message : '获取失败');
              }
            },
          })
        }
      >
        查看
      </Button>
    ) : null;
    return (
      <Space.Compact style={{ width: '100%' }}>
        <Input.Password placeholder="留空保持不变" autoComplete="new-password" />
        {reveal}
      </Space.Compact>
    );
  }
  if (s.type === 'int') return <InputNumber style={{ width: 160 }} />;
  return <Input placeholder={s.defaultsWork ? '（默认值即可）' : ''} />;
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
              { key: 'llm', label: 'LLM 网关', children: <LlmTab /> },
              { key: 'ops', label: '运营', children: <OpsTab /> },
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
  const [creating, setCreating] = useState<null | 'upstream' | 'html' | 'package'>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [visMode, setVisMode] = useState<string>('login');
  const [pkgFile, setPkgFile] = useState<{ name: string; dataBase64: string } | null>(null);
  const [pkgInfo, setPkgInfo] = useState<Record<string, unknown> | null>(null);

  const groupsQ = useQuery({ queryKey: ['admin-groups'], queryFn: () => api<{ groups: GroupRow[] }>('/api/admin/groups') });
  const usersQ = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ users: PublicUser[] }>('/api/admin/users') });
  const appsQ = useQuery({ queryKey: ['admin-apps'], queryFn: () => api<{ apps: AdminApp[] }>('/api/admin/apps') });

  const groupOptions = (groupsQ.data?.groups ?? []).map((g) => ({ value: g.id, label: g.name }));
  const userOptions = (usersQ.data?.users ?? []).map((u) => ({ value: u.id, label: `${u.name}（${u.username ?? u.id}）` }));

  const VIS_OPTIONS = [
    { value: 'public', label: '公开（免登录）' },
    { value: 'login', label: '需登录（全部用户）' },
    { value: 'restricted', label: '指定分组与账号' },
    { value: 'private', label: '仅自己（私有）' },
  ];

  function visExtra(): ReactNode {
    if (visMode !== 'restricted') return null;
    return (
      <>
        <Form.Item name="allowedGroupIds" label="可见分组" extra="命中任一分组的用户可见（分组即订阅等级）">
          <Select mode="multiple" placeholder="选择分组（可留空）" options={groupOptions} />
        </Form.Item>
        <Form.Item name="allowedUserIds" label="可见账号" extra="与分组任一命中即可见">
          <Select mode="multiple" placeholder="选择账号（可留空）" options={userOptions} />
        </Form.Item>
      </>
    );
  }

  async function saveApp(values: Record<string, unknown>): Promise<void> {
    try {
      if (creating === 'html') {
        await api('/api/admin/apps/html', { method: 'POST', json: values });
        message.success('HTML 应用已接入并生效');
      } else {
        await api('/api/admin/apps', { method: 'POST', json: values });
        message.success('应用已接入并生效');
      }
      setCreating(null);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['admin-apps'] });
      void qc.invalidateQueries({ queryKey: ['apps'] });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    }
  }

  async function uploadPackage(): Promise<void> {
    if (!pkgFile) {
      message.warning('请先选择 .neon-aap 包文件');
      return;
    }
    try {
      const acl = form.getFieldsValue() as { allowedGroupIds?: number[]; allowedUserIds?: number[]; passUser?: boolean; urlSecret?: string; visibility?: string };
      const r = await api<{ app: Record<string, unknown>; llmProvisioned: boolean }>('/api/admin/apps/package', {
        method: 'POST',
        json: {
          filename: pkgFile.name,
          dataBase64: pkgFile.dataBase64,
          visibility: acl.visibility ?? 'private',
          allowedGroupIds: acl.allowedGroupIds ?? [],
          allowedUserIds: acl.allowedUserIds ?? [],
          passUser: acl.passUser ?? false,
          urlSecret: acl.urlSecret || undefined,
        },
      });
      setPkgInfo(r.app);
      message.success(r.llmProvisioned ? '包校验通过并已接入；已自动签发 LLM 网关凭据' : '包校验通过并已接入');
      void qc.invalidateQueries({ queryKey: ['admin-apps'] });
      void qc.invalidateQueries({ queryKey: ['apps'] });
      void qc.invalidateQueries({ queryKey: ['llm-tokens'] });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '包校验失败');
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

  async function saveEdit(values: Record<string, unknown>): Promise<void> {
    if (!editing) return;
    try {
      await api(`/api/admin/apps/${editing.id}`, {
        method: 'PUT',
        json: {
          name: values.name,
          description: values.description,
          visibility: values.visibility,
          allowedGroupIds: values.allowedGroupIds ?? [],
          allowedUserIds: values.allowedUserIds ?? [],
          passUser: values.passUser,
          ...(values.urlSecret ? { urlSecret: values.urlSecret } : {}),
          ...(editing.kind === 'upstream' ? { upstream: values.upstream } : {}),
        },
      });
      message.success('已保存并生效');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['admin-apps'] });
      void qc.invalidateQueries({ queryKey: ['apps'] });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    }
  }

  const KIND_LABEL: Record<string, string> = { upstream: '反代', html: 'HTML', package: '包(待M4)' };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title="应用列表"
        extra={
          <Space size="small">
            <Button type="primary" onClick={() => { form.resetFields(); setVisMode('login'); setPkgFile(null); setPkgInfo(null); setEditing(null); setCreating('upstream'); }}>接入上游应用</Button>
            <Button onClick={() => { form.resetFields(); setVisMode('restricted'); setEditing(null); setCreating('html'); }}>接入 HTML 页</Button>
            <Button onClick={() => { form.resetFields(); setVisMode('private'); setPkgFile(null); setPkgInfo(null); setEditing(null); setCreating('package'); }}>上传 .neon-aap</Button>
          </Space>
        }
      >
        <Table<AdminApp>
          rowKey="id"
          dataSource={appsQ.data?.apps ?? []}
          pagination={false}
          size="small"
          columns={[
            { title: 'ID', dataIndex: 'id', width: 120 },
            { title: '名称', dataIndex: 'name', width: 130 },
            { title: '形态', width: 90, render: (_, r) => <Tag>{KIND_LABEL[r.kind] ?? r.kind}</Tag> },
            { title: '上游', dataIndex: 'upstream', ellipsis: true, render: (v: string) => v || '—' },
            {
              title: '可见性',
              width: 100,
              render: (_, r) => (
                <Tag>{r.visibility === 'public' ? '公开' : r.visibility === 'restricted' ? '指定可见' : r.visibility === 'private' ? '仅自己' : '登录'}</Tag>
              ),
            },
            { title: '健康', width: 90, render: (_, r) => dot(r.healthState) },
            {
              title: '操作',
              width: 230,
              render: (_, r) => (
                <Space size="small">
                  {r.kind === 'upstream' ? <Button size="small" onClick={() => void testApp(r)}>测试</Button> : null}
                  <Button
                    size="small"
                    onClick={() => {
                      setEditing(r);
                      setVisMode(r.visibility);
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

      <ReviewCard />

      <Card size="small" title="网关限流与超时" extra={<Tag bordered={false} color="green" style={{ fontSize: 11 }}>默认值即可跑</Tag>}>
        <SettingsForm groups={['应用网关']} />
      </Card>

      {/* 接入 / 编辑 弹窗 */}
      <Modal
        title={editing ? `编辑应用：${editing.name}` : creating === 'html' ? '接入 HTML 页' : creating === 'package' ? '上传 .neon-aap 包' : '接入上游应用'}
        open={Boolean(creating)}
        onCancel={() => { setCreating(null); setEditing(null); }}
        footer={null}
        width={580}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={creating === 'package' ? uploadPackage : saveApp}>
          {!editing ? (
            <Form.Item
              name="id"
              label="应用 ID（URL 前缀）"
              rules={[{ required: creating !== 'package', message: '必填' }, { pattern: /^[a-z0-9][a-z0-9-]*$/, message: '小写字母/数字/连字符' }]}
              extra={creating === 'package' ? '留空：自动取包内 manifest.name' : '访问地址为 https://你的域名/app/<ID>/'}
            >
              <Input disabled={Boolean(editing) || creating === 'package'} placeholder="my-app" />
            </Form.Item>
          ) : null}
          <Form.Item name="name" label="应用名称" rules={[{ required: creating !== 'package', message: '必填' }]}
            extra={creating === 'package' ? '留空：自动取包内 display_name' : undefined}>
            <Input placeholder="应用名" disabled={creating === 'package'} />
          </Form.Item>
          <Form.Item name="description" label="描述" extra="显示在门户卡片上">
            <Input placeholder="一句话介绍" />
          </Form.Item>

          {creating === 'package' ? (
            <Form.Item label="包文件（.zip / .neon-aap）" required extra="自动校验完整性与 manifest；python 包需等待 M4 运行时">
              <input
                type="file"
                accept=".zip,.neon-aap"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const reader = new FileReader();
                  reader.onload = () => setPkgFile({ name: f.name, dataBase64: String(reader.result).split(',')[1] ?? '' });
                  reader.readAsDataURL(f);
                }}
              />
              {pkgFile ? <div style={{ fontSize: 12, color: 'var(--aap-text-secondary)' }}>已选择：{pkgFile.name}</div> : null}
            </Form.Item>
          ) : null}

          {creating === 'upstream' || editing?.kind === 'upstream' ? (
            <Form.Item
              name="upstream"
              label="上游地址"
              rules={[{ required: true, message: '必填' }]}
              extra="仅允许本机/内网地址，如 http://127.0.0.1:8001"
            >
              <Input placeholder="http://127.0.0.1:8001" />
            </Form.Item>
          ) : null}

          {creating === 'html' ? (
            <Form.Item name="html" label="页面 HTML" rules={[{ required: true, message: '请填写页面内容' }]}
              extra="门户直接托管在 /app/<ID>/ 下；整页粘贴即可">
              <Input.TextArea rows={8} placeholder="<!doctype html>…" style={{ fontFamily: 'monospace', fontSize: 12 }} />
            </Form.Item>
          ) : null}

          {creating !== 'package' || pkgFile ? (
            <>
              <Form.Item name="visibility" label="可见性" initialValue={visMode} extra="指定分组与账号：命中任一即可见；分组可当订阅等级用">
                <Select options={VIS_OPTIONS} onChange={(v) => setVisMode(String(v))} />
              </Form.Item>
              {visExtra()}
              <Form.Item name="passUser" label="注入用户身份" valuePropName="checked" extra="向应用转发 X-AAP-Identity 签名头（自研应用识别登录用户）">
                <Switch />
              </Form.Item>
              <Form.Item
                name="urlSecret"
                label="上游凭据（可选）"
                extra='如 "token=xxx" 或 "__path__=/chat/xxx"，加密存储不下发'
              >
                <Input placeholder="token=xxx" />
              </Form.Item>
            </>
          ) : null}

          {creating === 'package' ? (
            <Button type="primary" htmlType="submit" block>校验并接入</Button>
          ) : (
            <Button type="primary" htmlType="submit" block>{editing ? '保存（即时生效）' : '接入'}</Button>
          )}
        </Form>
        {pkgInfo ? (
          <Alert type="success" showIcon style={{ marginTop: 10 }}
            message={`已接入：${String(pkgInfo.displayName)} v${String(pkgInfo.version)}（${String(pkgInfo.type)}）`}
            description={
              pkgInfo.llmProvisioned
                ? pkgInfo.pendingRuntime
                  ? '已自动签发 LLM 网关凭据（运行时启动时自动注入）。python 运行时将在 M4 启用。'
                  : '已自动签发 LLM 网关凭据。HTML 包已托管生效。'
                : pkgInfo.pendingRuntime
                  ? 'python 包已保存，等待 M4 运行时启用。'
                  : 'HTML 包已托管生效。'
            } />
        ) : null}
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

      <GroupsCard />

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
  const qc = useQueryClient();
  const settingsQ = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => api<{ settings: SettingRow[] }>('/api/admin/settings'),
  });
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const provider = (Form.useWatch('MAIL_PROVIDER', form) ??
    settingsQ.data?.settings.find((s) => s.key === 'MAIL_PROVIDER')?.value ??
    'smtp') as string;

  const defs = settingsQ.data?.settings ?? [];
  const visibleKeys =
    provider === 'resend'
      ? ['MAIL_PROVIDER', 'RESEND_API_KEY', 'RESEND_FROM']
      : ['MAIL_PROVIDER', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
  const visible = defs.filter((s) => visibleKeys.includes(s.key));

  useEffect(() => {
    if (settingsQ.data) {
      const values: Record<string, string> = {};
      for (const s of defs) values[s.key] = s.value;
      form.setFieldsValue(values);
    }
  }, [settingsQ.data, form, defs]);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const key of visibleKeys) {
        const v = form.getFieldValue(key);
        if (v !== undefined && v !== null) payload[key] = String(v);
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
      <Card size="small" title="发信通道（验证码用）" extra={<Tag bordered={false} color="blue" style={{ fontSize: 11 }}>Resend 仅需 API Key</Tag>}>
        <Form form={form} layout="vertical">
          <Form.Item
            name="MAIL_PROVIDER"
            label="发信方式"
            tooltip="Resend API：仅需 API Key 即可发信；SMTP 与 Resend 互斥（配置键 MAIL_PROVIDER）"
          >
            <Select
              options={[
                { value: 'smtp', label: 'SMTP 服务器' },
                { value: 'resend', label: 'Resend API' },
              ]}
              style={{ width: 220 }}
            />
          </Form.Item>

          {visible
            .filter((s) => s.key !== 'MAIL_PROVIDER')
            .map((s) => (
              <Form.Item key={s.key} name={s.key} label={s.label} tooltip={s.desc}>
                {renderControl(s, form, true)}
              </Form.Item>
            ))}

          <Button type="primary" loading={saving} onClick={() => void save()}>
            保存（即时生效）
          </Button>
        </Form>
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
      <Card size="small" title="证书状态" extra={st?.mode === 'acme' ? <Tag bordered={false} color="green" style={{ fontSize: 11 }}>自动续期已启用</Tag> : null}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="模式">{st?.mode === 'acme' ? '自动签发' : st?.mode === 'manual' ? '手动上传' : '未启用（纯门户模式）'}</Descriptions.Item>
          <Descriptions.Item label="HTTPS">{st?.httpsEnabled ? <Tag color="green">已启用（端口 {st.httpsPort}）</Tag> : <Tag>未启用</Tag>}</Descriptions.Item>
          {st?.cert ? <Descriptions.Item label="证书">{st.cert.subject}（剩余 {st.cert.daysRemaining} 天）</Descriptions.Item> : null}
          {st?.domain ? <Descriptions.Item label="ACME 域名">{st.domain}</Descriptions.Item> : null}
        </Descriptions>
        {st?.mode === 'acme' ? (
          <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>
            到期前 30 天自动重签并热替换，无需人工操作。
          </Typography.Paragraph>
        ) : null}
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

// ---------- LLM 网关（M2：上游 / 模型路由 / 网关凭据 / 调额 / 用量） ----------

interface LlmUpstream {
  id: number;
  name: string;
  baseUrl: string;
  enabled: boolean;
  hasKey: boolean;
}
interface LlmRoute {
  id: number;
  model: string;
  upstreamId: number;
  upstreamName: string;
  upstreamModel: string;
  multiplier: number;
  priority: number;
  weight: number;
  enabled: boolean;
}
interface LlmToken {
  id: number;
  appId: string;
  name: string;
  enabled: boolean;
  auto: boolean;
  perMinuteLimit: number | null;
  createdAt: string;
  lastUsedAt: string | null;
}
interface LedgerRow {
  id: number;
  ts: number;
  kind: string;
  userId: number | null;
  appId: string | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  delta: number;
  latencyMs: number | null;
  status: string;
}

function LlmTab(): ReactNode {
  const qc = useQueryClient();
  const upstreamsQ = useQuery({ queryKey: ['llm-upstreams'], queryFn: () => api<{ upstreams: LlmUpstream[] }>('/api/admin/llm/upstreams') });
  const routesQ = useQuery({ queryKey: ['llm-routes'], queryFn: () => api<{ routes: LlmRoute[] }>('/api/admin/llm/routes') });
  const tokensQ = useQuery({ queryKey: ['llm-tokens'], queryFn: () => api<{ tokens: LlmToken[] }>('/api/admin/llm/tokens') });
  const usersQ = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ users: PublicUser[] }>('/api/admin/users') });
  const usageQ = useQuery({ queryKey: ['llm-usage'], queryFn: () => api<{ rows: LedgerRow[] }>('/api/admin/llm/usage?limit=50') });

  const [upForm] = Form.useForm();
  const [routeForm] = Form.useForm();

  function invalidate(): void {
    for (const k of ['llm-upstreams', 'llm-routes', 'llm-tokens', 'llm-usage']) void qc.invalidateQueries({ queryKey: [k] });
  }

  const upstreamOptions = (upstreamsQ.data?.upstreams ?? []).map((u) => ({ value: u.id, label: `${u.name}（${u.baseUrl}）` }));

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        size="small"
        title="上游（OpenAI 兼容）"
        extra={
          <Button
            size="small"
            type="primary"
            onClick={async () => {
              const v = await upForm.validateFields();
              try {
                await api('/api/admin/llm/upstreams', { method: 'POST', json: v });
                message.success('上游已添加');
                upForm.resetFields();
                invalidate();
              } catch (err) {
                message.error(err instanceof Error ? err.message : '添加失败');
              }
            }}
          >
            添加上游
          </Button>
        }
      >
        <Table<LlmUpstream>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={upstreamsQ.data?.upstreams ?? []}
          columns={[
            { title: '名称', dataIndex: 'name', width: 140 },
            { title: 'Base URL', dataIndex: 'baseUrl', ellipsis: true },
            { title: 'Key', width: 80, render: (_, r) => (r.hasKey ? <Tag color="green">已配置</Tag> : <Tag>无</Tag>) },
            {
              title: '操作',
              width: 150,
              render: (_, r) => (
                <Space size="small">
                  <Button
                    size="small"
                    onClick={async () => {
                      await api(`/api/admin/llm/upstreams/${r.id}`, { method: 'PUT', json: { enabled: !r.enabled } });
                      invalidate();
                    }}
                  >
                    {r.enabled ? '停用' : '启用'}
                  </Button>
                  <Popconfirm title="删除该上游？其模型路由将一并删除。" onConfirm={async () => {
                    await api(`/api/admin/llm/upstreams/${r.id}`, { method: 'DELETE' });
                    invalidate();
                  }}>
                    <Button size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
        <Form form={upForm} layout="inline" style={{ marginTop: 10, rowGap: 8 }}>
          <Form.Item name="name" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="名称（如 智谱）" style={{ width: 140 }} />
          </Form.Item>
          <Form.Item name="baseUrl" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="https://.../compatible-mode/v1" style={{ width: 300 }} />
          </Form.Item>
          <Form.Item name="apiKey" rules={[{ required: true, message: '必填' }]}>
            <Input.Password placeholder="API Key" style={{ width: 220 }} autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Card>

      <Card size="small" title="模型路由（公开模型名 → 上游模型；同名多条 = failover 候选）">
        <Table<LlmRoute>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={routesQ.data?.routes ?? []}
          columns={[
            { title: '模型名', dataIndex: 'model', width: 150 },
            { title: '上游', dataIndex: 'upstreamName', width: 140 },
            { title: '上游模型', dataIndex: 'upstreamModel', width: 160, ellipsis: true },
            { title: '倍率‰', dataIndex: 'multiplier', width: 80 },
            { title: '优先级', dataIndex: 'priority', width: 80 },
            { title: '权重', dataIndex: 'weight', width: 70 },
            {
              title: '',
              width: 80,
              render: (_, r) => (
                <Popconfirm title="删除该路由？" onConfirm={async () => {
                  await api(`/api/admin/llm/routes/${r.id}`, { method: 'DELETE' });
                  invalidate();
                }}>
                  <Button size="small" danger>删除</Button>
                </Popconfirm>
              ),
            },
          ]}
        />
        <Form form={routeForm} layout="inline" style={{ marginTop: 10, rowGap: 8 }} onFinish={async (v) => {
          try {
            await api('/api/admin/llm/routes', { method: 'POST', json: { ...v, upstreamId: Number(v.upstreamId), multiplier: Number(v.multiplier ?? 100), priority: Number(v.priority ?? 100), weight: Number(v.weight ?? 100) } });
            message.success('路由已添加');
            routeForm.resetFields();
            invalidate();
          } catch (err) {
            message.error(err instanceof Error ? err.message : '添加失败');
          }
        }}>
          <Form.Item name="model" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="公开模型名" style={{ width: 150 }} />
          </Form.Item>
          <Form.Item name="upstreamId" rules={[{ required: true, message: '必选' }]}>
            <Select placeholder="上游" style={{ width: 180 }} options={upstreamOptions} />
          </Form.Item>
          <Form.Item name="upstreamModel" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="上游侧模型名" style={{ width: 170 }} />
          </Form.Item>
          <Form.Item name="multiplier" initialValue={100}>
            <Input placeholder="倍率‰=100" style={{ width: 110 }} />
          </Form.Item>
          <Form.Item name="priority" initialValue={100}>
            <Input placeholder="优先级=100" style={{ width: 110 }} />
          </Form.Item>
          <Form.Item name="weight" initialValue={100}>
            <Input placeholder="权重=100" style={{ width: 100 }} />
          </Form.Item>
          <Button htmlType="submit" type="primary">添加路由</Button>
        </Form>
      </Card>

      <Card
        size="small"
        title="运行时凭据（manifest 声明 llm 的包上传时自动签发，加密保管，运行时注入）"
        extra={<Tag bordered={false} color="blue" style={{ fontSize: 11 }}>自动签发</Tag>}
      >
        <Table<LlmToken>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={tokensQ.data?.tokens ?? []}
          columns={[
            { title: '应用', dataIndex: 'appId', width: 140 },
            { title: '名称', dataIndex: 'name', width: 140, render: (_, r) => (r.auto ? <Space size={4}><Tag color="blue" style={{ fontSize: 11 }}>自动签发</Tag>{r.name}</Space> : r.name) },
            { title: '限流/分', dataIndex: 'perMinuteLimit', width: 90, render: (v: number | null) => v ?? '默认' },
            { title: '状态', width: 90, render: (_, r) => (r.enabled ? <Tag color="green">启用</Tag> : <Tag color="red">已吊销</Tag>) },
            { title: '最近使用', width: 170, render: (_, r) => (r.lastUsedAt ? new Date(r.lastUsedAt).toLocaleString() : '—') },
            {
              title: '',
              width: 90,
              render: (_, r) => (
                <Popconfirm title="吊销该凭据？使用它的应用将立即 401。" onConfirm={async () => {
                  await api(`/api/admin/llm/tokens/${r.id}`, { method: 'DELETE' });
                  invalidate();
                }}>
                  <Button size="small" danger>吊销</Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Card>

      <Card size="small" title="调用账本（最近 50 条）">
        <Table<LedgerRow>
          rowKey="id"
          size="small"
          dataSource={usageQ.data?.rows ?? []}
          pagination={false}
          columns={[
            { title: '时间', width: 160, render: (_, r) => new Date(r.ts).toLocaleString() },
            { title: '类型', dataIndex: 'kind', width: 80 },
            { title: '用户', dataIndex: 'userId', width: 70 },
            { title: '应用', dataIndex: 'appId', width: 110 },
            { title: '模型', dataIndex: 'model', width: 140, ellipsis: true },
            { title: 'tokens', width: 110, render: (_, r) => (r.kind === 'usage' ? `${r.promptTokens ?? 0}+${r.completionTokens ?? 0}` : '—') },
            { title: '变动', dataIndex: 'delta', width: 90, render: (v: number) => <Typography.Text type={v < 0 ? 'danger' : undefined}>{v > 0 ? `+${v}` : v}</Typography.Text> },
            { title: '耗时', dataIndex: 'latencyMs', width: 90, render: (v: number | null) => (v != null ? `${v}ms` : '—') },
          ]}
        />
      </Card>

    </Space>
  );
}

// ---------- 用户分组管理（订阅等级 / 自定义组） ----------

function GroupsCard(): ReactNode {
  const qc = useQueryClient();
  const groupsQ = useQuery({ queryKey: ['admin-groups'], queryFn: () => api<{ groups: GroupRow[] }>('/api/admin/groups') });
  const usersQ = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ users: PublicUser[] }>('/api/admin/users') });
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<GroupRow | null>(null);
  const [editMemberIds, setEditMemberIds] = useState<number[]>([]);

  const userOptions = (usersQ.data?.users ?? []).map((u) => ({ value: u.id, label: `${u.name}（${u.username ?? u.id}）` }));

  async function reload(): Promise<void> {
    void qc.invalidateQueries({ queryKey: ['admin-groups'] });
  }

  return (
    <Card
      size="small"
      title="用户分组（订阅等级 / 自定义组；应用可见性与额度按分组配置）"
      extra={
        <Button
          size="small"
          type="primary"
          onClick={async () => {
            const name = window.prompt('新分组名称（如：订阅-高级）');
            if (!name) return;
            try {
              await api('/api/admin/groups', { method: 'POST', json: { name } });
              void reload();
            } catch (err) {
              message.error(err instanceof Error ? err.message : '创建失败');
            }
          }}
        >
          新建分组
        </Button>
      }
    >
      <Table<GroupRow>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={groupsQ.data?.groups ?? []}
        columns={[
          { title: '分组', dataIndex: 'name', width: 180 },
          { title: '备注', dataIndex: 'note', ellipsis: true },
          { title: '成员数', dataIndex: 'memberCount', width: 90 },
          {
            title: '操作',
            width: 160,
            render: (_, r) => (
              <Space size="small">
                <Button
                  size="small"
                  onClick={async () => {
                    const res = await api<{ memberIds: number[] }>(`/api/admin/groups/${r.id}/members`);
                    setEditMemberIds(res.memberIds);
                    setEditing(r);
                  }}
                >
                  成员
                </Button>
                <Popconfirm title="删除分组？应用可见性配置将失去该组。" onConfirm={async () => {
                  await api(`/api/admin/groups/${r.id}`, { method: 'DELETE' });
                  void reload();
                }}>
                  <Button size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={`分组成员：${editing?.name ?? ''}`}
        open={Boolean(editing)}
        onCancel={() => setEditing(null)}
        onOk={async () => {
          if (!editing) return;
          await api(`/api/admin/groups/${editing.id}`, { method: 'PUT', json: { memberIds: editMemberIds } });
          message.success('成员已更新');
          setEditing(null);
          void reload();
        }}
        okText="保存成员"
      >
        <Select
          mode="multiple"
          style={{ width: '100%' }}
          placeholder="选择该分组的成员"
          value={editMemberIds}
          onChange={(v) => setEditMemberIds(v as number[])}
          options={userOptions}
        />
      </Modal>
      <Form form={form} layout="inline" style={{ display: 'none' }}>
        <Form.Item name="noop">{null}</Form.Item>
      </Form>
    </Card>
  );
}

// ---------- 运营面板（M3，D4）：套餐 / 订单 / 排行 / 成本毛利 ----------

interface PlanRowUI {
  id: number;
  name: string;
  groupId: number;
  groupName: string;
  durationDays: number;
  priceFen: number;
  tokenGrant: number;
  enabled: boolean;
}
interface OrderRowUI {
  id: string;
  userId: number;
  kind: 'tokens' | 'membership';
  planId: number | null;
  tokens: number | null;
  priceFen: number;
  channel: string;
  status: 'pending' | 'paid' | 'cancelled';
  note: string | null;
  createdAt: number;
  paidAt: number | null;
}
interface OpsStatsUI {
  balanceTop: Array<{ userId: number; balance: number }>;
  spentTop: Array<{ userId: number; spent: number }>;
  appHot: Array<{ appId: string; calls: number; tokens: number }>;
  revenue30d: number;
  cost30d: number;
}

function fen2yuan(fen: number): string {
  return (fen / 100).toFixed(2);
}

function OpsTab(): ReactNode {
  const qc = useQueryClient();
  const usersQ = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ users: PublicUser[] }>('/api/admin/users') });
  const [adjustForm] = Form.useForm();
  const plansQ = useQuery({ queryKey: ['billing-plans'], queryFn: () => api<{ plans: PlanRowUI[] }>('/api/admin/billing/plans') });
  const ordersQ = useQuery({ queryKey: ['billing-orders'], queryFn: () => api<{ orders: OrderRowUI[] }>('/api/admin/billing/orders?status=pending') });
  const opsQ = useQuery({ queryKey: ['billing-ops'], queryFn: () => api<OpsStatsUI>('/api/admin/billing/ops') });
  const groupsQ = useQuery({ queryKey: ['admin-groups'], queryFn: () => api<{ groups: GroupRow[] }>('/api/admin/groups') });
  const [planForm] = Form.useForm();

  const ops = opsQ.data;
  const grossMargin = ops ? ops.revenue30d - ops.cost30d : 0;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <Card size="small" title="30 天收入（额度）">
          <Typography.Text strong style={{ fontSize: 22 }}>{ops?.revenue30d.toLocaleString() ?? '—'}</Typography.Text>
        </Card>
        <Card size="small" title="30 天上游成本">
          <Typography.Text strong style={{ fontSize: 22 }}>{ops?.cost30d.toLocaleString() ?? '—'}</Typography.Text>
        </Card>
        <Card size="small" title="毛利（额度）">
          <Typography.Text strong style={{ fontSize: 22, color: grossMargin >= 0 ? '#2E7D32' : '#ff4d4f' }}>
            {grossMargin.toLocaleString()}
          </Typography.Text>
        </Card>
        <Card size="small" title="待处理订单">
          <Typography.Text strong style={{ fontSize: 22 }}>{ordersQ.data?.orders.length ?? 0}</Typography.Text>
        </Card>
      </div>

      <Card size="small" title="功能订阅套餐">
        <Table<PlanRowUI>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={plansQ.data?.plans ?? []}
          columns={[
            { title: '名称', dataIndex: 'name', width: 140 },
            { title: '分组', dataIndex: 'groupName', width: 140 },
            { title: '时长', dataIndex: 'durationDays', width: 90, render: (v: number) => `${v} 天` },
            { title: '价格', dataIndex: 'priceFen', width: 90, render: (v: number) => `¥${fen2yuan(v)}` },
            { title: '赠额度', dataIndex: 'tokenGrant', width: 100 },
            { title: '状态', width: 80, render: (_, r) => (r.enabled ? <Tag color="green">在售</Tag> : <Tag>停售</Tag>) },
            {
              title: '操作',
              width: 160,
              render: (_, r) => (
                <Space size="small">
                  <Button size="small" onClick={async () => {
                    await api(`/api/admin/billing/plans/${r.id}`, { method: 'PUT', json: { enabled: !r.enabled } });
                    void qc.invalidateQueries({ queryKey: ['billing-plans'] });
                  }}>{r.enabled ? '停售' : '在售'}</Button>
                  <Popconfirm title="删除套餐？" onConfirm={async () => {
                    try {
                      await api(`/api/admin/billing/plans/${r.id}`, { method: 'DELETE' });
                      void qc.invalidateQueries({ queryKey: ['billing-plans'] });
                    } catch (err) {
                      message.error(err instanceof Error ? err.message : '删除失败');
                    }
                  }}>
                    <Button size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
        <Form form={planForm} layout="inline" style={{ marginTop: 10, rowGap: 8 }} onFinish={async (v) => {
          try {
            await api('/api/admin/billing/plans', {
              method: 'POST',
              json: { ...v, groupId: Number(v.groupId), durationDays: Number(v.durationDays), priceFen: Math.round(Number(v.priceFen ?? 0) * 100), tokenGrant: Number(v.tokenGrant ?? 0) },
            });
            message.success('套餐已创建');
            planForm.resetFields();
            void qc.invalidateQueries({ queryKey: ['billing-plans'] });
          } catch (err) {
            message.error(err instanceof Error ? err.message : '创建失败');
          }
        }}>
          <Form.Item name="name" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="套餐名（订阅-高级）" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="groupId" rules={[{ required: true, message: '必选' }]}>
            <Select placeholder="对应分组" style={{ width: 150 }} options={groupsQ.data?.groups.map((g) => ({ value: g.id, label: g.name }))} />
          </Form.Item>
          <Form.Item name="durationDays" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="时长(天)=30" style={{ width: 110 }} />
          </Form.Item>
          <Form.Item name="priceFen" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="价格(元)=30" style={{ width: 110 }} />
          </Form.Item>
          <Form.Item name="tokenGrant">
            <Input placeholder="赠额度=0" style={{ width: 100 }} />
          </Form.Item>
          <Button htmlType="submit" type="primary">创建套餐</Button>
        </Form>
      </Card>

      <Card size="small" title="待确认订单（人工确认到账；确认后权益/额度自动生效）">
        <Table<OrderRowUI>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={ordersQ.data?.orders ?? []}
          columns={[
            { title: '订单号', dataIndex: 'id', width: 170 },
            { title: '用户', dataIndex: 'userId', width: 70 },
            { title: '类型', width: 90, render: (_, r) => (r.kind === 'membership' ? '订阅' : '额度') },
            { title: '金额', width: 90, render: (_, r) => `¥${fen2yuan(r.priceFen)}` },
            { title: '到账', width: 110, render: (_, r) => (r.kind === 'tokens' ? `${r.tokens?.toLocaleString()} 额度` : '订阅权益') },
            { title: '创建时间', width: 160, render: (_, r) => new Date(r.createdAt).toLocaleString() },
            {
              title: '操作',
              width: 160,
              render: (_, r) => (
                <Space size="small">
                  <Popconfirm title={`确认已收到 ¥${fen2yuan(r.priceFen)}？确认后立即生效。`} onConfirm={async () => {
                    await api(`/api/admin/billing/orders/${r.id}/confirm`, { method: 'POST' });
                    message.success('已确认到账');
                    void qc.invalidateQueries({ queryKey: ['billing-orders'] });
                    void qc.invalidateQueries({ queryKey: ['billing-ops'] });
                  }}>
                    <Button size="small" type="primary">确认到账</Button>
                  </Popconfirm>
                  <Button size="small" onClick={async () => {
                    await api(`/api/admin/billing/orders/${r.id}/cancel`, { method: 'POST' });
                    void qc.invalidateQueries({ queryKey: ['billing-orders'] });
                  }}>取消</Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <RedeemCard />

      <Card size="small" title="用户额度发放 / 调减">
        <Form layout="inline" form={adjustForm} onFinish={async (v) => {
          try {
            const r = await api<{ balance: number }>('/api/admin/llm/adjust', {
              method: 'POST',
              json: { userId: Number(v.userId), delta: Number(v.delta), note: v.note },
            });
            message.success(`已调整，当前余额 ${r.balance}`);
            adjustForm.resetFields();
            void qc.invalidateQueries({ queryKey: ['billing-ops'] });
            void qc.invalidateQueries({ queryKey: ['llm-usage'] });
          } catch (err) {
            message.error(err instanceof Error ? err.message : '调整失败');
          }
        }}>
          <Form.Item name="userId" rules={[{ required: true, message: '必选' }]}>
            <Select
              placeholder="选择用户"
              style={{ width: 180 }}
              showSearch
              optionFilterProp="label"
              options={(usersQ.data?.users ?? []).map((u) => ({ value: u.id, label: `${u.name}（${u.username ?? u.id}）` }))}
            />
          </Form.Item>
          <Form.Item name="delta" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="变动量（±token）" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="note">
            <Input placeholder="备注" style={{ width: 180 }} />
          </Form.Item>
          <Button htmlType="submit" type="primary">确认调整</Button>
        </Form>
      </Card>


      <Card size="small" title="计费设置">
        <SettingsForm groups={['计费']} />
      </Card>


      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
        <Card size="small" title="余额排行">
          {(ops?.balanceTop ?? []).map((r, i) => (
            <div key={r.userId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '2px 0' }}>
              <span>#{i + 1} 用户 {r.userId}</span>
              <Typography.Text strong>{r.balance.toLocaleString()}</Typography.Text>
            </div>
          ))}
        </Card>
        <Card size="small" title="消耗排行（30 天）">
          {(ops?.spentTop ?? []).map((r, i) => (
            <div key={r.userId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '2px 0' }}>
              <span>#{i + 1} 用户 {r.userId}</span>
              <Typography.Text type="danger">-{r.spent.toLocaleString()}</Typography.Text>
            </div>
          ))}
        </Card>
        <Card size="small" title="应用热度（30 天）">
          {(ops?.appHot ?? []).map((r) => (
            <div key={r.appId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '2px 0' }}>
              <span>{r.appId}</span>
              <span style={{ color: 'var(--aap-text-secondary)' }}>{r.calls} 次 / {r.tokens.toLocaleString()} tokens</span>
            </div>
          ))}
        </Card>
      </div>
    </Space>
  );
}

// ---------- 卡券码（充值码/订阅码批量生成与兑换管理） ----------

interface RedeemBatch {
  batchId: string;
  kind: 'tokens' | 'membership';
  total: number;
  used: number;
  tokens: number | null;
  planId: number | null;
  note: string | null;
  expiresAt: number | null;
  createdAt: number;
}
interface RedeemCodeRowUI {
  code: string;
  kind: string;
  tokens: number | null;
  status: 'unused' | 'used' | 'disabled';
  usedBy: number | null;
  expiresAt: number | null;
}

function RedeemCard(): ReactNode {
  const qc = useQueryClient();
  const batchesQ = useQuery({ queryKey: ['redeem-batches'], queryFn: () => api<{ batches: RedeemBatch[] }>('/api/admin/redeem/batches') });
  const plansQ = useQuery({ queryKey: ['billing-plans'], queryFn: () => api<{ plans: PlanRowUI[] }>('/api/admin/billing/plans') });
  const [form] = Form.useForm();
  const [kind, setKind] = useState<'tokens' | 'membership'>('tokens');
  const [generated, setGenerated] = useState<string[] | null>(null);
  const [viewBatch, setViewBatch] = useState<string>('');

  const codesQ = useQuery({
    queryKey: ['redeem-codes', viewBatch],
    queryFn: () => api<{ codes: RedeemCodeRowUI[] }>(`/api/admin/redeem/codes?limit=200${viewBatch ? `&batchId=${viewBatch}` : ''}`),
  });

  function invalidate(): void {
    void qc.invalidateQueries({ queryKey: ['redeem-batches'] });
    void qc.invalidateQueries({ queryKey: ['redeem-codes'] });
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title="生成卡券码（额度码 / 订阅码）">
        <Form form={form} layout="inline" style={{ rowGap: 8 }} onFinish={async (v) => {
          try {
            const r = await api<{ batchId: string; codes: string[] }>('/api/admin/redeem/batches', {
              method: 'POST',
              json: {
                kind,
                count: Number(v.count),
                tokens: kind === 'tokens' ? Number(v.tokens) : undefined,
                planId: kind === 'membership' ? Number(v.planId) : undefined,
                expiresInDays: v.expiresInDays ? Number(v.expiresInDays) : null,
                note: v.note || undefined,
              },
            });
            setGenerated(r.codes);
            invalidate();
          } catch (err) {
            message.error(err instanceof Error ? err.message : '生成失败');
          }
        }}>
          <Form.Item name="kind" initialValue="tokens" rules={[{ required: true }]}>
            <Select
              style={{ width: 120 }}
              onChange={(v) => setKind(v as 'tokens' | 'membership')}
              options={[
                { value: 'tokens', label: '额度码' },
                { value: 'membership', label: '订阅码' },
              ]}
            />
          </Form.Item>
          {kind === 'tokens' ? (
            <Form.Item name="tokens" rules={[{ required: true, message: '必填' }]}>
              <Input placeholder="每张面额(token)" style={{ width: 150 }} />
            </Form.Item>
          ) : (
            <Form.Item name="planId" rules={[{ required: true, message: '必选' }]}>
              <Select
                placeholder="绑定套餐"
                style={{ width: 170 }}
                options={(plansQ.data?.plans ?? []).map((p) => ({ value: p.id, label: `${p.name}（${p.durationDays}天）` }))}
              />
            </Form.Item>
          )}
          <Form.Item name="count" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="数量=10" style={{ width: 100 }} />
          </Form.Item>
          <Form.Item name="expiresInDays">
            <Input placeholder="有效天数(可选)" style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name="note">
            <Input placeholder="备注" style={{ width: 140 }} />
          </Form.Item>
          <Button htmlType="submit" type="primary">生成</Button>
        </Form>

        {generated ? (
          <div style={{ marginTop: 10 }}>
            <Space style={{ marginBottom: 6 }}>
              <Button
                size="small"
                type="primary"
                icon={<CopyOutlined />}
                onClick={async () => {
                  await navigator.clipboard.writeText(generated.join('\n'));
                  message.success(`已复制 ${generated.length} 个码`);
                }}
              >
                复制全部（{generated.length} 个）
              </Button>
              <Typography.Text type="secondary">每行一个码，仅本次展示（可随时按批次查询）</Typography.Text>
            </Space>
            <Input.TextArea rows={Math.min(8, generated.length)} readOnly value={generated.join('\n')} style={{ fontFamily: 'monospace', fontSize: 12 }} />
          </div>
        ) : null}
      </Card>

      <Card
        size="small"
        title="批次与码查询"
        extra={
          <Button size="small" onClick={() => { invalidate(); }}>刷新</Button>
        }
      >
        <Table<RedeemBatch>
          rowKey="batchId"
          size="small"
          pagination={false}
          dataSource={batchesQ.data?.batches ?? []}
          columns={[
            { title: '批次', dataIndex: 'batchId', width: 110 },
            { title: '类型', width: 90, render: (_, r) => (r.kind === 'tokens' ? '额度码' : '订阅码') },
            { title: '面额/套餐', width: 130, render: (_, r) => (r.kind === 'tokens' ? `${r.tokens?.toLocaleString()} 额度` : `套餐 #${r.planId}`) },
            { title: '用量', width: 110, render: (_, r) => `${r.used}/${r.total}` },
            { title: '备注', dataIndex: 'note', ellipsis: true },
            {
              title: '',
              width: 110,
              render: (_, r) => (
                <Button size="small" onClick={() => setViewBatch(r.batchId)}>查看码</Button>
              ),
            },
          ]}
        />
        {viewBatch ? (
          <div style={{ marginTop: 10 }}>
            <Typography.Text type="secondary">批次 {viewBatch}：</Typography.Text>
            <Table<RedeemCodeRowUI>
              rowKey="code"
              size="small"
              pagination={false}
              dataSource={(codesQ.data?.codes ?? []).filter((c) => c.status !== 'disabled')}
              columns={[
                { title: '码', dataIndex: 'code', render: (v: string) => <Typography.Text copyable code>{v}</Typography.Text> },
                { title: '状态', width: 100, render: (_, r) => (r.status === 'unused' ? <Tag color="green">未用</Tag> : r.status === 'used' ? <Tag>已用</Tag> : <Tag color="red">作废</Tag>) },
                { title: '使用者', dataIndex: 'usedBy', width: 90 },
                {
                  title: '',
                  width: 90,
                  render: (_, r) =>
                    r.status === 'unused' ? (
                      <Popconfirm title="作废该码？" onConfirm={async () => {
                        await api('/api/admin/redeem/disable', { method: 'POST', json: { code: r.code } });
                        invalidate();
                      }}>
                        <Button size="small" danger>作废</Button>
                      </Popconfirm>
                    ) : null,
                },
              ]}
            />
          </div>
        ) : null}
      </Card>
    </Space>
  );
}

// ---------- 审核卡（G3：包审核——看声明/通过/驳回） ----------

interface PendingApp {
  id: string;
  name: string;
  description: string;
  ownerUserId: number | null;
  visibility: string;
  manifest: Record<string, unknown> | null;
  submittedAt: number;
}

function ReviewCard(): ReactNode {
  const qc = useQueryClient();
  const pendingQ = useQuery({ queryKey: ['review-pending'], queryFn: () => api<{ pending: PendingApp[] }>('/api/admin/review/pending') });
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [note, setNote] = useState('');

  function invalidate(): void {
    void qc.invalidateQueries({ queryKey: ['review-pending'] });
    void qc.invalidateQueries({ queryKey: ['admin-apps'] });
    void qc.invalidateQueries({ queryKey: ['apps'] });
  }

  const list = pendingQ.data?.pending ?? [];

  return (
    <Card size="small" title={`应用审核（${list.length} 个待审）`}>
      {list.length === 0 ? (
        <Typography.Text type="secondary">暂无待审核应用</Typography.Text>
      ) : (
        list.map((p) => (
          <Card key={p.id} size="small" style={{ marginBottom: 10 }} title={`${p.name}（${p.id}）`}>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="归属者">用户 {p.ownerUserId}</Descriptions.Item>
              <Descriptions.Item label="提交时间">{new Date(p.submittedAt).toLocaleString()}</Descriptions.Item>
              <Descriptions.Item label="类型">{String(p.manifest?.type ?? '—')} / {String(p.manifest?.runtime ?? '—')}</Descriptions.Item>
              <Descriptions.Item label="能力声明">
                {(Array.isArray(p.manifest?.capabilities) ? (p.manifest!.capabilities as string[]) : []).map((c) => (
                  <Tag key={c} color="blue" style={{ fontSize: 11 }}>{c}</Tag>
                ))}
              </Descriptions.Item>
              <Descriptions.Item label="出站白名单">
                {(Array.isArray(p.manifest?.network) ? (p.manifest!.network as string[]) : []).join('、') || '（无出站）'}
              </Descriptions.Item>
            </Descriptions>
            <Space wrap style={{ marginTop: 8 }}>
              <Select
                style={{ width: 170 }}
                value="public"
                onChange={() => void 0}
                id={`vis-${p.id}`}
                options={[
                  { value: 'public', label: '公开' },
                  { value: 'restricted', label: '指定可见（需再配 ACL）' },
                ]}
              />
              <Button
                type="primary"
                onClick={async () => {
                  const el = document.getElementById(`vis-${p.id}`) as HTMLInputElement | null;
                  void el;
                  await api(`/api/admin/review/${p.id}/approve`, { method: 'POST', json: { visibility: 'public' } });
                  message.success('已通过并公开');
                  invalidate();
                }}
              >
                通过
              </Button>
              <Button danger onClick={() => setRejectId(p.id)}>
                驳回
              </Button>
            </Space>
          </Card>
        ))
      )}
      <Modal
        title="驳回（附理由）"
        open={Boolean(rejectId)}
        onCancel={() => setRejectId(null)}
        onOk={async () => {
          if (!rejectId) return;
          await api(`/api/admin/review/${rejectId}/reject`, { method: 'POST', json: { note } });
          message.success('已驳回');
          setRejectId(null);
          setNote('');
          invalidate();
        }}
      >
        <Input.TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="驳回理由将展示给作者" />
      </Modal>
    </Card>
  );
}
