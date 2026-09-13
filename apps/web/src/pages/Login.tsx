import { Card, Typography } from 'antd';

/** 登录页占位（W3 落地：本地账号 + PoW + 注册/找回；W4 挂 MFA 挑战状态机）。 */
export function LoginPage() {
  return (
    <Card style={{ maxWidth: 420, margin: '48px auto' }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        登录
      </Typography.Title>
      <Typography.Text type="secondary">
        登录 / 注册 / 找回密码在 W3（账号体系）与 W4（MFA）落地，本页为路由占位。
      </Typography.Text>
    </Card>
  );
}
