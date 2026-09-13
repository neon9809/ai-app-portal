/** 应用打开页（B1）：同源 iframe 嵌入反代应用 + 统一顶栏（返回门户 / 新窗口）。 */
import { Button, Result, Spin } from 'antd';
import { ArrowLeftOutlined, ExportOutlined } from '@ant-design/icons';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { AppCard } from '@aap/shared';
import { api } from '../api/client';

export function AppFramePage() {
  const { id = '' } = useParams();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['apps'],
    queryFn: () => api<{ apps: AppCard[] }>('/api/apps'),
  });
  const app = data?.apps.find((a) => a.id === id);

  if (isLoading) {
    return (
      <div style={{ textAlign: 'center', padding: 80 }}>
        <Spin />
      </div>
    );
  }
  if (isError || !app) {
    return <Result status="404" title="应用不存在" extra={<a href="/">返回门户</a>} />;
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'var(--aap-bg-layout)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        className="aap-header"
        style={{ position: 'relative', top: 0, padding: '0 16px', height: 48 }}
      >
        <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => history.back()}>
          返回
        </Button>
        <Button size="small" type="primary" ghost onClick={() => (window.location.href = '/')}>
          应用门户
        </Button>
        <strong style={{ fontSize: 14 }}>{app.name}</strong>
        {app.description ? (
          <span className="aap-tagline" style={{ fontSize: 12 }}>
            {app.description}
          </span>
        ) : null}
        <div style={{ flex: 1 }} />
        <Button
          size="small"
          icon={<ExportOutlined />}
          onClick={() => window.open(`/app/${encodeURIComponent(app.id)}/`, '_blank')}
        >
          新窗口打开
        </Button>
      </div>
      <iframe
        src={`/app/${encodeURIComponent(app.id)}/`}
        title={app.name}
        style={{ flex: 1, border: 0, width: '100%' }}
        allow="clipboard-read; clipboard-write; microphone; camera"
      />
    </div>
  );
}
