/**
 * 用户中心（A4）：个人信息 / 安全（改密、MFA、会话管理）/ 账单（M3 占位）/ 注销。
 * 敏感操作（换绑邮箱、注销、MFA 管理）前置步升认证：重输密码或 TOTP。
 */
import {
  Alert,
  ColorPicker,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { obtainPowToken } from '../lib/pow';
import { useSession } from '../state/session';
import { BUILTIN_THEMES, useTheme } from '../theme/themes';

// ---------- 步升认证弹窗 ----------

function useStepUp(): [ReactNode, () => Promise<boolean>] {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resolveRef, setResolveRef] = useState<((ok: boolean) => void) | null>(null);
  const [form] = Form.useForm();

  const ensure = (): Promise<boolean> => {
    // 已在步升窗口内 → 直接放行
    if (me?.stepUpUntil && me.stepUpUntil > Date.now()) return Promise.resolve(true);
    form.resetFields();
    setOpen(true);
    return new Promise((resolve) => setResolveRef(() => resolve));
  };

  const close = (ok: boolean): void => {
    setOpen(false);
    resolveRef?.(ok);
    setResolveRef(null);
  };

  async function submitPassword(values: { password: string }): Promise<void> {
    setLoading(true);
    try {
      await api('/api/auth/step-up/password', { method: 'POST', json: values });
      close(true);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '验证失败');
    } finally {
      setLoading(false);
    }
  }

  async function submitTotp(values: { token: string }): Promise<void> {
    setLoading(true);
    try {
      await api('/api/auth/step-up/totp', { method: 'POST', json: values });
      close(true);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '验证失败');
    } finally {
      setLoading(false);
    }
  }

  const modal = (
    <Modal
      title="验证身份（敏感操作）"
      open={open}
      onCancel={() => close(false)}
      footer={null}
      destroyOnClose
    >
      <Tabs
        items={[
          {
            key: 'password',
            label: '密码',
            children: (
              <Form form={form} onFinish={submitPassword} layout="vertical">
                <Form.Item name="password" rules={[{ required: true, message: '请输入当前密码' }]}>
                  <Input.Password autoFocus />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={loading} block>
                  确认
                </Button>
              </Form>
            ),
          },
          ...(me?.user.mfaEnabled
            ? [
                {
                  key: 'totp',
                  label: 'TOTP',
                  children: (
                    <Form form={form} onFinish={submitTotp} layout="vertical">
                      <Form.Item name="token" rules={[{ required: true, message: '请输入验证码' }]}>
                        <Input maxLength={6} placeholder="6 位验证码" />
                      </Form.Item>
                      <Button type="primary" htmlType="submit" loading={loading} block>
                        确认
                      </Button>
                    </Form>
                  ),
                },
              ]
            : []),
        ]}
      />
    </Modal>
  );

  return [modal, ensure];
}

// ---------- 主页面 ----------

interface SessionRow {
  id: string;
  current: boolean;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export function AccountPage() {
  const { me, refetch } = useSession();
  const qc = useQueryClient();
  const [stepUpModal, ensureStepUp] = useStepUp();
  const [profileForm] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [emailModal, setEmailModal] = useState(false);
  const [emailForm] = Form.useForm();
  const [deleteModal, setDeleteModal] = useState(false);
  const [deleteForm] = Form.useForm();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sending, setSending] = useState(false);
  const [emailSending, setEmailSending] = useState(false);

  const user = me?.user;

  useEffect(() => {
    if (user) profileForm.setFieldsValue({ name: user.name });
  }, [user, profileForm]);

  async function loadSessions(): Promise<void> {
    try {
      const r = await api<{ sessions: SessionRow[] }>('/api/user/sessions');
      setSessions(r.sessions);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    if (me) void loadSessions();
  }, [me]);

  if (!me || !user) {
    return <Alert type="info" showIcon message="请先登录" description={<a href="/login">去登录</a>} />;
  }

  async function saveProfile(values: { name: string }): Promise<void> {
    setSaving(true);
    try {
      await api('/api/user/profile', { method: 'PATCH', json: values });
      message.success('已保存');
      void refetch();
      void qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function changePassword(values: { currentPassword: string; newPassword: string }): Promise<void> {
    try {
      await api('/api/auth/change-password', { method: 'POST', json: values });
      message.success('密码已修改，其他设备已退出登录');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '修改失败');
    }
  }

  async function sendEmailCode(newEmail: string): Promise<void> {
    setSending(true);
    try {
      const ok = await ensureStepUp();
      if (!ok) return;
      const powToken = await obtainPowToken();
      const r = await api<{ sentTo: string; viaLogFallback: boolean }>('/api/user/email/change/start', {
        method: 'POST',
        json: { newEmail, powToken },
      });
      message.success(r.viaLogFallback ? '验证码在服务端日志中' : `验证码已发送至 ${r.sentTo}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'STEP_UP_REQUIRED') {
        message.info('请先完成身份验证');
      } else {
        message.error(err instanceof Error ? err.message : '发送失败');
      }
    } finally {
      setSending(false);
    }
  }

  async function verifyEmailChange(values: { newEmail: string; code: string }): Promise<void> {
    setEmailSending(true);
    try {
      await api('/api/user/email/change/verify', { method: 'POST', json: values });
      message.success('邮箱已更新');
      setEmailModal(false);
      void refetch();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '验证失败');
    } finally {
      setEmailSending(false);
    }
  }

  async function requestDelete(): Promise<void> {
    const ok = await ensureStepUp();
    if (!ok) return;
    setDeleteModal(true);
  }

  async function confirmDelete(): Promise<void> {
    try {
      await api('/api/user/delete/request', { method: 'POST' });
      message.warning('注销申请已提交，7 天内可撤回');
      setDeleteModal(false);
      void refetch();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '操作失败');
    }
  }

  async function cancelDelete(): Promise<void> {
    await api('/api/user/delete/cancel', { method: 'POST' });
    message.success('已撤回注销申请');
    void refetch();
  }

  async function kickSession(row: SessionRow): Promise<void> {
    await api(`/api/user/sessions/${row.id}`, { method: 'DELETE' });
    message.success('已下线该会话');
    void loadSessions();
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      {stepUpModal}
      {me.user.status === 'deletion_pending' ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="账号注销中"
          description="账号将在 7 天后删除并匿名化，期间可随时撤回。"
          action={
            <Button size="small" danger onClick={() => void cancelDelete()}>
              撤回注销
            </Button>
          }
        />
      ) : null}

      <Typography.Title level={4}>个人中心</Typography.Title>

      <Tabs
        items={[
          {
            key: 'appearance',
            label: '外观',
            children: <AppearanceTab />,
          },
          {
            key: 'profile',
            label: '个人资料',
            children: (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Card title="基础资料">
                  <Form form={profileForm} layout="vertical" onFinish={saveProfile} style={{ maxWidth: 420 }}>
                    <Form.Item name="name" label="昵称" rules={[{ required: true, message: '昵称不能为空' }]}>
                      <Input maxLength={64} />
                    </Form.Item>
                    <Descriptions column={1} size="small" style={{ marginBottom: 16 }}>
                      <Descriptions.Item label="用户名">{user.username ?? '—'}</Descriptions.Item>
                      <Descriptions.Item label="邮箱">{user.email ?? '未绑定'}</Descriptions.Item>
                      <Descriptions.Item label="角色">
                        {user.role === 'admin' ? <Tag color="gold">管理员</Tag> : <Tag>用户</Tag>}
                      </Descriptions.Item>
                    </Descriptions>
                    <Button type="primary" htmlType="submit" loading={saving}>
                      保存
                    </Button>
                  </Form>
                </Card>
                <Card title="绑定邮箱">
                  <Typography.Paragraph type="secondary">
                    当前：{user.email ?? '未绑定'}。换绑需先验证身份，再验证新邮箱。
                  </Typography.Paragraph>
                  <Button
                    onClick={() => {
                      emailForm.resetFields();
                      setEmailModal(true);
                    }}
                  >
                    换绑邮箱
                  </Button>
                </Card>
              </Space>
            ),
          },
          {
            key: 'security',
            label: '安全',
            children: (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Card title="修改密码">
                  <Form layout="vertical" onFinish={changePassword} style={{ maxWidth: 420 }}>
                    <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true }]}>
                      <Input.Password />
                    </Form.Item>
                    <Form.Item
                      name="newPassword"
                      label="新密码"
                      rules={[{ required: true }, { min: 8, max: 128, message: '8-128 位' }]}
                    >
                      <Input.Password />
                    </Form.Item>
                    <Button htmlType="submit" type="primary">
                      修改密码
                    </Button>
                  </Form>
                </Card>
                <Card title="多因子认证（MFA）">
                  {user.mfaEnabled ? (
                    <Tag color="green">已启用</Tag>
                  ) : (
                    <Tag color="orange">未启用</Tag>
                  )}
                  <Typography.Paragraph type="secondary" style={{ margin: '8px 0' }}>
                    推荐 TOTP 验证器 + Passkey 双因子。管理员账号强制启用。
                  </Typography.Paragraph>
                  <Space>
                    <a href="/mfa-setup">
                      <Button type="primary">绑定 / 管理</Button>
                    </a>
                  </Space>
                </Card>
                <Card title="登录会话">
                  <Table<SessionRow>
                    size="small"
                    rowKey="id"
                    dataSource={sessions}
                    pagination={false}
                    columns={[
                      {
                        title: '设备 / IP',
                        render: (_, r) => (
                          <div>
                            <div style={{ fontSize: 12 }}>{(r.userAgent ?? '未知设备').slice(0, 60)}</div>
                            <div style={{ color: 'var(--aap-text-secondary)', fontSize: 12 }}>{r.ip ?? '—'}</div>
                          </div>
                        ),
                      },
                      {
                        title: '最近活跃',
                        width: 150,
                        render: (_, r) => new Date(r.lastSeenAt).toLocaleString(),
                      },
                      {
                        title: '',
                        width: 110,
                        render: (_, r) =>
                          r.current ? (
                            <Tag>当前会话</Tag>
                          ) : (
                            <Popconfirm title="下线该会话？" onConfirm={() => void kickSession(r)}>
                              <Button size="small" danger>
                                踢下线
                              </Button>
                            </Popconfirm>
                          ),
                      },
                    ]}
                  />
                </Card>
              </Space>
            ),
          },
          {
            key: 'billing',
            label: '账务',
            children: (
              <Card title="会员与 Token">
                <Descriptions column={1}>
                  <Descriptions.Item label="当前计划">
                    {user.plan === 'member' ? <Tag color="gold">会员</Tag> : <Tag>免费版</Tag>}
                  </Descriptions.Item>
                  <Descriptions.Item label="Token 余额">—</Descriptions.Item>
                </Descriptions>
                <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
                  会员订阅与 Token 充值将在 M3（计费闭环）上线后开放。
                </Typography.Paragraph>
              </Card>
            ),
          },
          {
            key: 'danger',
            label: '注销账号',
            children: (
              <Card title="注销账号">
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="注销后 7 天冷静期，期间可撤回"
                  description="冷静期结束后，账号数据将被匿名化且不可恢复；审计记录按合规要求脱敏保留。"
                />
                <Button danger onClick={() => void requestDelete()}>
                  申请注销账号
                </Button>
              </Card>
            ),
          },
        ]}
      />

      <Modal title="换绑邮箱" open={emailModal} onCancel={() => setEmailModal(false)} footer={null} destroyOnClose>
        <Form form={emailForm} layout="vertical" onFinish={verifyEmailChange}>
          <Form.Item
            name="newEmail"
            label="新邮箱"
            rules={[{ required: true, message: '请输入新邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}
          >
            <Input
              onBlur={undefined}
              onPressEnter={undefined}
              onChange={(e) => emailForm.setFieldValue('newEmail', e.target.value)}
            />
          </Form.Item>
          <Button
            block
            style={{ marginBottom: 12 }}
            loading={emailSending}
            onClick={async () => {
              const newEmail = String(emailForm.getFieldValue('newEmail') ?? '');
              setSending(true);
              try {
                const ok = await ensureStepUp();
                if (!ok) return;
                const powToken = await obtainPowToken();
                const r = await api<{ sentTo: string; viaLogFallback: boolean }>('/api/user/email/change/start', {
                  method: 'POST',
                  json: { newEmail, powToken },
                });
                message.success(r.viaLogFallback ? '验证码在服务端日志中' : `验证码已发送至 ${r.sentTo}`);
              } catch (err) {
                if (err instanceof ApiError && err.code === 'STEP_UP_REQUIRED') {
                  message.info('请先在弹窗中验证身份');
                } else {
                  message.error(err instanceof Error ? err.message : '发送失败');
                }
              } finally {
                setSending(false);
              }
            }}
          >
            发送验证码（需先验证身份）
          </Button>
          <Form.Item name="code" label="验证码" rules={[{ required: true, message: '请输入验证码' }]}>
            <Input maxLength={6} placeholder="6 位验证码" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={emailSending}>
            确认换绑
          </Button>
        </Form>
      </Modal>

      <Modal
        title="确认注销账号"
        open={deleteModal}
        onCancel={() => setDeleteModal(false)}
        footer={null}
        destroyOnClose
      >
        <Alert type="error" showIcon style={{ marginBottom: 12 }} message="此操作不可逆（冷静期后）" />
        <Form form={deleteForm} onFinish={confirmDelete}>
          <Form.Item
            name="confirm"
            rules={[{ required: true, message: '请输入「注销」确认' }]}
          >
            <Input placeholder='输入「注销」以确认' />
          </Form.Item>
          <Button danger type="primary" htmlType="submit" block>
            提交注销申请
          </Button>
        </Form>
      </Modal>
    </div>
  );
}

// ---------- 外观（R3：个性化主题；默认主题由管理员配置） ----------

function AppearanceTab(): ReactNode {
  const { theme, themeId, accent, setThemeId, setAccent, resetPersonal } = useTheme();
  void theme;
  return (
    <Card title="个性化外观" extra={<Button size="small" onClick={resetPersonal}>恢复站点默认</Button>}>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        站点默认主题与强调色由管理员统一配置；这里的选择只对你本人当前浏览器生效。
      </Typography.Paragraph>
      <Typography.Title level={5} style={{ fontSize: 13 }}>主题</Typography.Title>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
        {BUILTIN_THEMES.map((t) => (
          <div
            key={t.id}
            onClick={() => setThemeId(t.id)}
            style={{
              border: `2px solid ${t.id === themeId ? 'var(--aap-primary)' : 'var(--aap-border)'}`,
              borderRadius: 10,
              padding: 10,
              cursor: 'pointer',
              background: t.colors.bgLayout,
            }}
          >
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {[t.colors.primary, t.colors.accent, t.colors.bgContainer].map((c, i) => (
                <span key={i} style={{ width: 18, height: 18, borderRadius: 5, background: c, border: '1px solid rgba(0,0,0,0.08)', display: 'inline-block' }} />
              ))}
            </div>
            <div style={{ color: t.colors.text, fontSize: 13, fontWeight: 600 }}>
              {t.name}
              {t.id === themeId ? <span style={{ color: t.colors.primary }}> · 当前</span> : null}
            </div>
          </div>
        ))}
      </div>
      <Typography.Title level={5} style={{ fontSize: 13, marginTop: 16 }}>强调色</Typography.Title>
      <Space>
        <ColorPicker value={accent ?? undefined} onChange={(c: { toHexString: () => string }) => setAccent(c.toHexString())} onClear={() => setAccent(null)} allowClear showText />
        <Typography.Text type="secondary">{accent ?? '跟随主题默认'}</Typography.Text>
      </Space>
    </Card>
  );
}
