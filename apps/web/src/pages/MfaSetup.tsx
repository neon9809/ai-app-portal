/**
 * MFA 绑定页（A3 / F3 强制流程第二步）：TOTP（扫码/密钥 + 即时码确认 +
 * 恢复码出示）或 Passkey。admin 强制场景完成即回门户；普通用户不强制，
 * 可「跳过绑定」稍后在个人中心完成；已绑齐两种因子时引导去个人中心管理。
 */
import { Alert, Button, Card, Form, Input, Tabs, Typography, message } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../api/client';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '../state/session';
import { useStepUp, withStepUp } from '../components/StepUpModal';
import { registerNewPasskey } from '../lib/mfaClient';

interface MfaStatusView {
  totpConfirmed: boolean;
  passkeys: unknown[];
}

export function MfaSetupPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { me } = useSession();
  const [stepUpModal, ensureStepUp] = useStepUp();
  const [totp, setTotp] = useState<{ secret: string; otpauthUri: string; qr: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();
  /** 已绑因子预检结果：null=检查中；决定自动 enroll、默认 Tab 与「已绑齐」引导 */
  const [bound, setBound] = useState<MfaStatusView | null>(null);

  async function startTotp(): Promise<void> {
    const r = await api<{ secret: string; otpauthUri: string }>('/api/auth/mfa/totp/enroll', { method: 'POST' });
    const qr = await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 220 });
    setTotp({ ...r, qr });
  }

  function startTotpGuarded(): Promise<void> {
    return startTotp().catch((err) => {
      message.error(err instanceof Error ? err.message : '生成绑定密钥失败');
    });
  }

  async function confirmTotpCode(): Promise<void> {
    const { token } = await form.validateFields();
    setLoading(true);
    try {
      await withStepUp(ensureStepUp, async () => {
        const r = await api<{ recoveryCodes: string[] }>('/api/auth/mfa/totp/confirm', {
          method: 'POST',
          json: { token },
        });
        setRecoveryCodes(r.recoveryCodes);
        void qc.invalidateQueries({ queryKey: ['me'] });
      });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '验证失败');
    } finally {
      setLoading(false);
    }
  }

  async function registerPasskey(): Promise<void> {
    setLoading(true);
    try {
      await withStepUp(ensureStepUp, async () => {
        await registerNewPasskey(`Passkey ${new Date().toLocaleDateString()}`);
        message.success('Passkey 绑定成功');
        void qc.invalidateQueries({ queryKey: ['me'] });
        setRecoveryCodes([]); // 视为完成（Passkey 无恢复码）
      });
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Passkey 绑定失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void (async () => {
      // 预检已绑因子：服务端 enroll 对已确认 TOTP 直接 409，不预检会把已绑用户卡在报错页
      try {
        const status = await api<MfaStatusView>('/api/auth/mfa/status');
        setBound({ totpConfirmed: status.totpConfirmed, passkeys: status.passkeys });
        if (status.totpConfirmed) return; // TOTP 已绑（含只差 Passkey）：不自动重发 enroll 密钥
      } catch {
        setBound({ totpConfirmed: false, passkeys: [] }); // 状态读不到按未绑处理，报错由 enroll 如实透出
      }
      try {
        // 登录步升窗口（5min）过期时 enroll 会 403，弹步升窗重验后重试
        await withStepUp(ensureStepUp, startTotp);
      } catch {
        /* 用户取消步升：留给 TOTP Tab 的手动「生成绑定密钥」按钮 */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const forced = me?.mustEnrollMfa === true;

  if (bound?.totpConfirmed && bound.passkeys.length > 0) {
    return (
      <Card style={{ maxWidth: 480, margin: '48px auto' }}>
        {stepUpModal}
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          绑定多因子认证
        </Typography.Title>
        <Alert
          type="info"
          showIcon
          message="TOTP 验证器与 Passkey 均已绑定"
          description="无需重复绑定；解绑、恢复码等管理操作请前往个人中心。"
          action={
            <Button size="small" onClick={() => navigate('/account')}>
              前往个人中心
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <Card style={{ maxWidth: 480, margin: '48px auto' }}>
      {stepUpModal}
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        绑定多因子认证
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        {forced
          ? '为保护账号安全，请绑定 TOTP 验证器（推荐）或 Passkey。'
          : '推荐绑定 TOTP 验证器或 Passkey 提升账号安全性；也可以跳过，稍后在个人中心完成。'}
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
      ) : bound === null ? (
        <Typography.Text type="secondary">正在检查绑定状态…</Typography.Text>
      ) : (
        <>
          <Tabs
            defaultActiveKey={bound.totpConfirmed ? 'passkey' : 'totp'}
            items={[
              {
                key: 'totp',
                label: 'TOTP 验证器',
                children: bound.totpConfirmed ? (
                  <Typography.Text type="secondary">
                    TOTP 验证器已绑定；解绑、恢复码管理请前往个人中心。
                  </Typography.Text>
                ) : totp ? (
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
                ) : (
                  <Button block onClick={() => void startTotpGuarded()}>
                    生成绑定密钥
                  </Button>
                ),
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
          {me && !forced ? (
            <Button type="link" block onClick={() => navigate('/')}>
              跳过绑定
            </Button>
          ) : null}
        </>
      )}
    </Card>
  );
}
