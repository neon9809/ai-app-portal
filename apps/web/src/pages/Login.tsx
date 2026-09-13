/**
 * 登录页（A2/A3）：密码登录 → PoW 条件网关 → MFA 挑战（TOTP/恢复码/Passkey）
 * → 强制流程跳转（改密 / 绑 MFA）。
 */
import { Alert, Button, Card, Form, Input, Tabs, Typography, message } from 'antd';
import { KeyOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { startAuthentication } from '@simplewebauthn/browser';
import { api, ApiError } from '../api/client';
import { obtainPowToken, solvePow, type PowChallenge } from '../lib/pow';
import { usePostAuthRedirect } from '../state/session';
import type { SessionInfo } from '@aap/shared';

type LoginResult = SessionInfo & { mfaRequired: boolean };

export function LoginPage() {
  const navigate = useNavigate();
  const redirect = usePostAuthRedirect();
  const [loading, setLoading] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaLoading, setMfaLoading] = useState(false);
  const [powHint, setPowHint] = useState<string | null>(null);

  async function proceed(r: { mustChangePassword?: boolean; mustEnrollMfa?: boolean }): Promise<void> {
    message.success('登录成功');
    redirect(r);
  }

  async function onFinish(values: { username: string; password: string }): Promise<void> {
    setLoading(true);
    try {
      const r = await api<LoginResult>('/api/auth/login', {
        method: 'POST',
        json: { username: values.username, password: values.password },
      });
      if (r.mfaRequired) {
        setMfaRequired(true);
        return;
      }
      await proceed(r);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'POW_REQUIRED') {
        // 条件 PoW：解挑战后自动重试一次
        setPowHint('检测到异常尝试，正在进行工作量证明（PoW）…');
        try {
          const ch = err.errorBody?.challenge as PowChallenge | undefined;
          if (!ch) throw new Error('no challenge');
          const nonce = await solvePow(ch);
          const { token } = await api<{ token: string }>('/api/auth/pow/verify', {
            method: 'POST',
            json: { challengeId: ch.challengeId, nonce },
          });
          const r = await api<LoginResult>('/api/auth/login', {
            method: 'POST',
            json: { username: values.username, password: values.password, powToken: token },
          });
          if (r.mfaRequired) {
            setMfaRequired(true);
            return;
          }
          await proceed(r);
          return;
        } catch (retryErr) {
          message.error(retryErr instanceof Error ? retryErr.message : '登录失败');
        }
      } else if (err instanceof ApiError && err.code === 'IP_BANNED') {
        const until = err.errorBody?.bannedUntil as number | undefined;
        message.error(`该地址已被封禁${until ? `，至 ${new Date(until).toLocaleTimeString()}` : ''}`);
      } else {
        message.error(err instanceof Error ? err.message : '登录失败');
      }
    } finally {
      setLoading(false);
    }
  }

  async function onMfaSubmit(values: { token: string }): Promise<void> {
    setMfaLoading(true);
    try {
      const r = await api<SessionInfo>('/api/auth/mfa/login/totp', {
        method: 'POST',
        json: { token: values.token },
      });
      await proceed(r);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '验证失败');
    } finally {
      setMfaLoading(false);
    }
  }

  async function onPasskeyLogin(): Promise<void> {
    setMfaLoading(true);
    try {
      const { requestId, options } = await api<{ requestId: string; options: unknown }>(
        '/api/auth/mfa/login/passkey/options',
        { method: 'POST' },
      );
      const response = await startAuthentication({ optionsJSON: options as never });
      const r = await api<SessionInfo>('/api/auth/mfa/login/passkey/verify', {
        method: 'POST',
        json: { requestId, response },
      });
      await proceed(r);
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Passkey 验证失败');
    } finally {
      setMfaLoading(false);
    }
  }

  return (
    <Card style={{ maxWidth: 420, margin: '48px auto' }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        登录
      </Typography.Title>

      {mfaRequired ? (
        <>
          <Alert type="info" showIcon message="已验证密码，请完成多因子认证" style={{ marginBottom: 16 }} />
          <Tabs
            items={[
              {
                key: 'totp',
                label: (
                  <span>
                    <SafetyCertificateOutlined /> 验证器 / 恢复码
                  </span>
                ),
                children: (
                  <Form onFinish={onMfaSubmit}>
                    <Form.Item name="token" rules={[{ required: true, message: '请输入 6 位验证码或恢复码' }]}>
                      <Input placeholder="6 位验证码或恢复码 xxxx-xxxx" size="large" autoFocus />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" loading={mfaLoading} block>
                      验证
                    </Button>
                  </Form>
                ),
              },
              {
                key: 'passkey',
                label: (
                  <span>
                    <KeyOutlined /> Passkey
                  </span>
                ),
                children: (
                  <Button onClick={onPasskeyLogin} loading={mfaLoading} block>
                    使用 Passkey 验证
                  </Button>
                ),
              },
            ]}
          />
          <Button type="link" onClick={() => navigate('/login')} style={{ paddingLeft: 0 }}>
            返回重新登录
          </Button>
        </>
      ) : (
        <>
          <Form onFinish={onFinish} layout="vertical">
            <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
              <Input placeholder="用户名" size="large" autoFocus />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password placeholder="密码" size="large" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block size="large">
              登录
            </Button>
          </Form>
          {powHint ? (
            <Alert type="warning" showIcon message={powHint} style={{ marginTop: 12 }} />
          ) : null}
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between' }}>
            <Link to="/register">注册账号</Link>
            <Link to="/forgot">忘记密码</Link>
          </div>
        </>
      )}
    </Card>
  );
}
