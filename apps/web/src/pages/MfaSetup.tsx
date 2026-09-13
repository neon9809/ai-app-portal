/**
 * MFA 绑定页（A3 / F3 强制流程第二步）：TOTP（扫码/密钥 + 即时码确认 +
 * 恢复码出示）或 Passkey。管理端强制场景完成即回门户。
 */
import { Alert, Button, Card, Form, Input, Tabs, Typography, message } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { startRegistration } from '@simplewebauthn/browser';
import { api } from '../api/client';
import { useQueryClient } from '@tanstack/react-query';

export function MfaSetupPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [totp, setTotp] = useState<{ secret: string; otpauthUri: string; qr: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  async function startTotp(): Promise<void> {
    try {
      const r = await api<{ secret: string; otpauthUri: string }>('/api/auth/mfa/totp/enroll', { method: 'POST' });
      const qr = await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 220 });
      setTotp({ ...r, qr });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '生成绑定密钥失败');
    }
  }

  async function confirmTotpCode(): Promise<void> {
    const { token } = await form.validateFields();
    setLoading(true);
    try {
      const r = await api<{ recoveryCodes: string[] }>('/api/auth/mfa/totp/confirm', {
        method: 'POST',
        json: { token },
      });
      setRecoveryCodes(r.recoveryCodes);
      void qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '验证失败');
    } finally {
      setLoading(false);
    }
  }

  async function registerPasskey(): Promise<void> {
    setLoading(true);
    try {
      const options = await api('/api/auth/mfa/passkey/register-options', { method: 'POST' });
      const response = await startRegistration({ optionsJSON: options as never });
      await api('/api/auth/mfa/passkey/register-verify', {
        method: 'POST',
        json: { nickname: `Passkey ${new Date().toLocaleDateString()}`, response },
      });
      message.success('Passkey 绑定成功');
      void qc.invalidateQueries({ queryKey: ['me'] });
      setRecoveryCodes([]); // 视为完成（Passkey 无恢复码）
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Passkey 绑定失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (totp === null && !recoveryCodes) void startTotp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card style={{ maxWidth: 480, margin: '48px auto' }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        绑定多因子认证
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        为保护账号安全，请绑定 TOTP 验证器（推荐）或 Passkey。
      </Typography.Paragraph>

      {recoveryCodes ? (
        <>
          {recoveryCodes.length > 0 ? (
            <>
              <Alert
                type="warning"
                showIcon
                message="请保存恢复码"
                description="每个恢复码只能使用一次，用于验证器丢失时登录。关闭本页后不会再显示。"
                style={{ marginBottom: 12 }}
              />
              <Card size="small" style={{ marginBottom: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontFamily: 'monospace' }}>
                  {recoveryCodes.map((c) => (
                    <span key={c}>{c}</span>
                  ))}
                </div>
              </Card>
            </>
          ) : null}
          <Button type="primary" block onClick={() => navigate('/')}>
            我已保存，完成
          </Button>
        </>
      ) : (
        <Tabs
          items={[
            {
              key: 'totp',
              label: 'TOTP 验证器',
              children: totp ? (
                <div style={{ textAlign: 'center' }}>
                  <img src={totp.qr} alt="TOTP 二维码" style={{ borderRadius: 8 }} />
                  <Typography.Paragraph copyable={{ text: totp.secret }} type="secondary" style={{ fontSize: 12 }}>
                    {totp.secret}
                  </Typography.Paragraph>
                  <Form form={form} layout="inline" style={{ justifyContent: 'center' }}>
                    <Form.Item
                      name="token"
                      rules={[{ required: true, message: '输入 6 位即时码' }, { len: 6, message: '6 位数字' }]}
                    >
                      <Input placeholder="123456" maxLength={6} size="large" style={{ width: 160 }} />
                    </Form.Item>
                    <Button type="primary" loading={loading} onClick={confirmTotpCode}>
                      确认绑定
                    </Button>
                  </Form>
                </div>
              ) : null,
            },
            {
              key: 'passkey',
              label: 'Passkey',
              children: (
                <Button type="primary" loading={loading} onClick={registerPasskey} block>
                  注册本设备的 Passkey
                </Button>
              ),
            },
          ]}
        />
      )}
    </Card>
  );
}
