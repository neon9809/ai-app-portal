/**
 * 强制改密页（F3 初始流程第一步：初始密码登录 → 设新密码）。
 * 同时作为用户中心「修改密码」的基础表单（W8 复用）。
 */
import { Button, Card, Form, Input, Typography, message } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { usePostAuthRedirect } from '../state/session';

export function ForceChangePasswordPage() {
  const navigate = useNavigate();
  const redirect = usePostAuthRedirect();
  const [loading, setLoading] = useState(false);

  async function onFinish(values: { currentPassword: string; newPassword: string }): Promise<void> {
    setLoading(true);
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        json: values,
      });
      message.success('密码已更新');
      // 强制流程下一步：绑 MFA（/api/auth/me 会重新计算）
      navigate('/mfa-setup', { replace: true });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '修改失败');
    } finally {
      setLoading(false);
    }
  }
  void redirect;

  return (
    <Card style={{ maxWidth: 440, margin: '48px auto' }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        设置新密码
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        您当前使用的是初始密码，请立即设置新密码后继续。
      </Typography.Paragraph>
      <Form layout="vertical" onFinish={onFinish}>
        <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
          <Input.Password autoFocus />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="新密码"
          rules={[{ required: true, message: '请输入新密码' }, { min: 8, max: 128, message: '8-128 位' }]}
        >
          <Input.Password />
        </Form.Item>
        <Form.Item
          name="newPassword2"
          label="确认新密码"
          dependencies={['newPassword']}
          rules={[
            { required: true, message: '请再次输入新密码' },
            ({ getFieldValue }) => ({
              validator: (_, v) =>
                !v || v === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次输入不一致')),
            }),
          ]}
        >
          <Input.Password />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading} block>
          保存并继续
        </Button>
      </Form>
    </Card>
  );
}
