/** 找回密码（A2）：邮箱 + 验证码重置；服务端防枚举（不存在也返回 ok）。 */
import { Alert, Button, Card, Form, Input, Typography, message } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { obtainPowToken } from '../lib/pow';

export function ForgotPage() {
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');

  async function onStart(values: { email: string }): Promise<void> {
    setLoading(true);
    setEmail(values.email);
    try {
      const powToken = await obtainPowToken();
      await api('/api/auth/forgot/start', { method: 'POST', json: { email: values.email, powToken } });
      setSent(true);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '发送失败');
    } finally {
      setLoading(false);
    }
  }

  async function onReset(values: { code: string; newPassword: string }): Promise<void> {
    setLoading(true);
    try {
      await api('/api/auth/forgot/verify', {
        method: 'POST',
        json: { email, code: values.code, newPassword: values.newPassword },
      });
      message.success('密码已重置，请用新密码登录');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '重置失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card style={{ maxWidth: 440, margin: '48px auto' }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        找回密码
      </Typography.Title>

      {!sent ? (
        <Form layout="vertical" onFinish={onStart}>
          <Form.Item
            name="email"
            label="注册邮箱"
            rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}
          >
            <Input autoFocus />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block>
            发送验证码
          </Button>
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <Link to="/login">返回登录</Link>
          </div>
        </Form>
      ) : (
        <>
          <Alert type="success" showIcon style={{ marginBottom: 16 }} message="若该邮箱已注册，验证码将发送至邮箱（5 分钟有效）" />
          <Form layout="vertical" onFinish={onReset}>
            <Form.Item name="code" label="验证码" rules={[{ required: true, message: '请输入验证码' }]}>
              <Input maxLength={6} autoFocus />
            </Form.Item>
            <Form.Item
              name="newPassword"
              label="新密码"
              rules={[{ required: true, message: '请输入新密码' }, { min: 8, max: 128, message: '8-128 位' }]}
            >
              <Input.Password />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>
              重置密码
            </Button>
          </Form>
        </>
      )}
    </Card>
  );
}
