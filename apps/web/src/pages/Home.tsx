import { Alert, Card, Descriptions, Space, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { PortalBootstrap } from '@aap/shared';
import { api } from '../api/client';
import { useTheme } from '../theme/themes';

export function HomePage() {
  const { data, isError } = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api<PortalBootstrap>('/api/portal/bootstrap'),
  });
  const { theme } = useTheme();

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {isError ? (
        <Alert type="warning" showIcon message="服务端未连接" description="请确认 apps/server 已在 8080 端口运行（pnpm dev）。" />
      ) : null}
      <Card title="W1 骨架已就绪">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="站点">{data?.branding.siteName ?? '…'}</Descriptions.Item>
          <Descriptions.Item label="注册开关">
            {data?.registration.mode === 'closed' ? <Tag>关闭</Tag> : <Tag color="green">{data?.registration.mode}</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label="初始化状态">
            {data?.needsInit ? <Tag color="gold">待初始化管理员（W9 引导流程）</Tag> : <Tag color="green">已完成</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label="当前主题">
            {theme.name}（右上可切换，CSS variables + AntD token 双写实时生效）
          </Descriptions.Item>
        </Descriptions>
      </Card>
      <Card size="small" title="接下来">
        W2 安全内核 → W3 账号注册 → W4 MFA → W5 应用网关（路径反代 + WS） → W6 自动 HTTPS → W7 门户卡片墙
      </Card>
    </Space>
  );
}
