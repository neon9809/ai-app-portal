/** 注册页（A2）：读门户注册开关；两步注册（资料 → 邮箱验证码）；全程 PoW。 */
import { Alert, Button, Card, Form, Input, Result, Typography, message } from 'antd';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { PortalBootstrap } from '@aap/shared';
import { api } from '../api/client';
import { obtainPowToken } from '../lib/pow';
import { usePostAuthRedirect } from '../state/session';

interface StartResult {
  registrationId: string;
  sentTo: string;
  viaLogFallback: boolean;
}

export function RegisterPage() {
  const navigate = useNavigate();
  const redirect = usePostAuthRedirect();
  const { data: boot } = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api<PortalBootstrap>('/api/portal/bootstrap'),
  });
  const [step, setStep] = useState<'form' | 'code'>(boot?.registration.mode === 'open' ? 'form' : 'form');
  const [start, setStart] = useState<StartResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  const mode = boot?.registration.mode ?? 'closed';

  async function onFormFinish(values: {
    username: string;
    password: string;
    email: string;
    inviteCode?: string;
  }): Promise<void> {
    setLoading(true);
    try {
      const powToken = await obtainPowToken();
      const r = await api<StartResult>('/api/auth/register/start', {
        method: 'POST',
        json: { ...values, powToken },
      });
      setStart(r);
      setStep('code');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '注册失败');
    } finally {
      setLoading(false);
    }
  }

  async function onCodeFinish(values: { code: string }): Promise<void> {
    if (!start) return;
    setLoading(true);
    try {
      const r = await api<{ mustChangePassword: boolean; mustEnrollMfa: boolean }>(
        '/api/auth/register/verify',
        { method: 'POST', json: { registrationId: start.registrationId, code: values.code } },
      );
      message.success('注册成功');
      redirect(r);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '验证失败');
    } finally {
      setLoading(false);
    }
  }

  if (mode === 'closed') {
    return (
      <Result
        status="403"
        title="本站未开放注册"
        subTitle="如需账号，请联系管理员。"
        extra={<Link to="/login">返回登录</Link>}
      />
    );
  }

  return (
    <Card style={{ maxWidth: 440, margin: '48px auto' }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        注册账号
      </Typography.Title>

      {step === 'form' ? (
        <Form form={form} layout="vertical" onFinish={onFormFinish}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[
              { required: true, message: '请输入用户名' },
              { pattern: /^[a-z0-9][a-z0-9_.-]{2,63}$/, message: '3-64 位小写字母/数字/_.- ，字母或数字开头' },
            ]}
          >
            <Input placeholder="小写字母与数字" autoFocus />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[
              { required: true, message: '请输入密码' },
              { min: 8, max: 128, message: '8-128 位' },
            ]}
          >
            <Input.Password placeholder="至少 8 位" />
          </Form.Item>
          <Form.Item
            name="password2"
            label="确认密码"
            dependencies={['password']}
            rules={[
              { required: true, message: '请再次输入密码' },
              ({ getFieldValue }) => ({
                validator: (_, v) =>
                  !v || v === getFieldValue('password')
                    ? Promise.resolve()
                    : Promise.reject(new Error('两次输入不一致')),
              }),
            ]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item
            name="email"
            label="邮箱"
            rules={[
              { required: true, message: '请输入邮箱' },
              { type: 'email', message: '邮箱格式不正确' },
            ]}
            extra="用于接收验证码与找回密码"
          >
            <Input />
          </Form.Item>
          {mode === 'invite' ? (
            <Form.Item name="inviteCode" label="邀请码" rules={[{ required: true, message: '本站注册需邀请码' }]}>
              <Input placeholder="xxxx-xxxx" />
            </Form.Item>
          ) : null}
          <Button type="primary" htmlType="submit" loading={loading} block>
            获取邮箱验证码
          </Button>
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <Link to="/login">已有账号？登录</Link>
          </div>
        </Form>
      ) : (
        <>
          <Alert
            type={start?.viaLogFallback ? 'warning' : 'success'}
            showIcon
            style={{ marginBottom: 16 }}
            message={
              start?.viaLogFallback
                ? `验证码已发送（服务端未配置 SMTP，验证码在服务端日志中）`
                : `验证码已发送至 ${start?.sentTo ?? ''}，5 分钟内有效`
            }
          />
          <Form layout="vertical" onFinish={onCodeFinish}>
            <Form.Item name="code" rules={[{ required: true, message: '请输入 6 位验证码' }]}>
              <Input placeholder="6 位验证码" size="large" autoFocus maxLength={6} />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>
              完成注册
            </Button>
          </Form>
        </>
      )}
    </Card>
  );
}
