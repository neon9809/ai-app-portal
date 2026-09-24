/** MFA 前端共用：Passkey 注册三步（取 options → 浏览器弹窗采集 → 提交验证） */
import { startRegistration } from '@simplewebauthn/browser';
import { api } from '../api/client';

export async function registerNewPasskey(nickname: string): Promise<void> {
  const options = await api('/api/auth/mfa/passkey/register-options', { method: 'POST' });
  const response = await startRegistration({ optionsJSON: options as never });
  await api('/api/auth/mfa/passkey/register-verify', { method: 'POST', json: { nickname, response } });
}
