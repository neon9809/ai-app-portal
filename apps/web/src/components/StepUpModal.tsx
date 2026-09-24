/**
 * 步升认证弹窗（敏感操作前重验一次因子：密码或 TOTP）。
 * 个人中心（换绑邮箱/注销/MFA 管理）与 MFA 绑定页共用；
 * withStepUp 供动作侧兜底：首个 403 STEP_UP_REQUIRED 弹窗重验后重试一次。
 */
import { Button, Form, Input, Modal, Tabs, message } from 'antd';
import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import { useSession } from '../state/session';

export function useStepUp(): [ReactNode, () => Promise<boolean>] {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resolveRef, setResolveRef] = useState<((ok: boolean) => void) | null>(null);
  // 两个 Tab 各自独立实例：共用一个实例时 Tabs 切换后两 Form 同时挂载，
  // 提交会对隐藏 Tab 的必填字段一并校验，导致 TOTP 提交静默失败
  const [passwordForm] = Form.useForm();
  const [totpForm] = Form.useForm();

  const ensure = (): Promise<boolean> => {
    // 已在步升窗口内 → 直接放行
    if (me?.stepUpUntil && me.stepUpUntil > Date.now()) return Promise.resolve(true);
    passwordForm.resetFields();
    totpForm.resetFields();
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
              <Form form={passwordForm} onFinish={submitPassword} layout="vertical">
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
                    <Form form={totpForm} onFinish={submitTotp} layout="vertical">
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

/** 步升兜底执行：fn 抛 STEP_UP_REQUIRED 时弹步升窗，重验成功后重试一次；取消步升则维持原错误 */
export async function withStepUp<T>(ensure: () => Promise<boolean>, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'STEP_UP_REQUIRED') {
      if (!(await ensure())) throw err;
      return await fn();
    }
    throw err;
  }
}
