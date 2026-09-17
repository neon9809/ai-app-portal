/** 门户首页（A1）：应用卡片墙——分类分组、搜索、锁定态、健康状态点。 */
import { Card, Empty, Input, Spin, Tag, Tooltip } from 'antd';
import { LockOutlined, SearchOutlined } from '@ant-design/icons';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { withBase } from '../lib/base';
import { useQuery } from '@tanstack/react-query';
import type { AppCard, PortalBootstrap } from '@aap/shared';
import { api } from '../api/client';
import { useSession } from '../state/session';

const VISIBILITY_LABEL: Record<AppCard['visibility'], string> = {
  public: '公开',
  login: '需登录',
  restricted: '指定可见',
  private: '仅自己',
};

function StatusDot({ status }: { status: AppCard['status'] }) {
  const color = status === 'ok' ? '#52c41a' : status === 'down' ? '#ff4d4f' : '#d9d9d9';
  const title = status === 'ok' ? '运行正常' : status === 'down' ? '上游异常' : '状态未知';
  return (
    <Tooltip title={title}>
      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: color }} />
    </Tooltip>
  );
}

function AppTile({ app }: { app: AppCard }) {
  const inner = (
    <Card
      size="small"
      hoverable={app.accessible}
      style={{
        height: '100%',
        opacity: app.accessible ? 1 : 0.72,
        borderColor: 'var(--aap-border)',
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            background: 'var(--aap-bg-layout)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 22,
            flexShrink: 0,
          }}
        >
          {app.icon ?? app.name.slice(0, 1)}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {app.name}
            </span>
            <StatusDot status={app.status} />
            {!app.accessible ? <LockOutlined style={{ color: 'var(--aap-text-secondary)', fontSize: 12 }} /> : null}
          </div>
          <div
            style={{
              color: 'var(--aap-text-secondary)',
              fontSize: 12,
              marginTop: 2,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              minHeight: 32,
            }}
          >
            {app.description || '　'}
          </div>
        </div>
      </div>
      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Tag bordered={false} style={{ fontSize: 11 }}>
          {VISIBILITY_LABEL[app.visibility]}
        </Tag>
        {app.accessible ? (
          <span style={{ color: 'var(--aap-primary)', fontSize: 12 }}>打开 →</span>
        ) : (
          <span style={{ color: 'var(--aap-text-secondary)', fontSize: 12 }}>
            {app.visibility === 'login' || app.visibility === 'restricted' ? '登录后可用' : '暂不可用'}
          </span>
        )}
      </div>
    </Card>
  );

  const isTool = app.kind === 'package' && app.runtimeMode === 'invoked';
  // 直接跳应用本体：门户导航由注入的 chrome 悬浮条承载（W0），无需 /open 包装页。
  // /app/* 是服务端网关路由，必须整页跳转而非 SPA Link
  const target = withBase(isTool ? `/run/${app.id}` : `/app/${encodeURIComponent(app.id)}/`);
  return app.accessible ? (
    <a href={target} style={{ textDecoration: 'none', color: 'inherit' }}>
      {inner}
    </a>
  ) : (
    <Link to="/login">{inner}</Link>
  );
}

export function HomePage() {
  const { me } = useSession();
  const [keyword, setKeyword] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['apps'],
    queryFn: () => api<{ apps: AppCard[] }>('/api/apps'),
  });
  const boot = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api<PortalBootstrap>('/api/portal/bootstrap'),
  });

  const filtered = useMemo(() => {
    const apps = data?.apps ?? [];
    const kw = keyword.trim().toLowerCase();
    const hit = apps.filter(
      (a) => !kw || a.name.toLowerCase().includes(kw) || a.description.toLowerCase().includes(kw),
    );
    const groups = new Map<string, AppCard[]>();
    for (const a of hit) {
      const list = groups.get(a.category) ?? [];
      list.push(a);
      groups.set(a.category, list);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data, keyword]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20 }}>
            你好{me ? `，${me.user.name}` : ''}，欢迎来到 {boot.data?.branding.siteName ?? 'AI应用门户'}
          </h2>
          <p style={{ margin: '4px 0 0', color: 'var(--aap-text-secondary)', fontSize: 13 }}>
            {boot.data?.needsInit
              ? '⚠ 站点尚未初始化：请首次启动时按容器日志中的初始凭据登录完成引导。'
              : '从下方选择一个应用开始。应用经平台统一代理，支持 WebSocket / SSE。'}
          </p>
        </div>
        <div style={{ flex: 1 }} />
        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: 'var(--aap-text-secondary)' }} />}
          placeholder="搜索应用"
          style={{ width: 240 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 64 }}>
          <Spin />
        </div>
      ) : filtered.length === 0 ? (
        <Empty description={keyword ? '没有匹配的应用' : '还没有应用，管理员可在后台接入第一个应用'} />
      ) : (
        filtered.map(([category, apps]) => (
          <section key={category} style={{ marginBottom: 24 }}>
            <h3 style={{ fontSize: 14, color: 'var(--aap-text-secondary)', margin: '0 0 8px' }}>{category}</h3>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: 12,
              }}
            >
              {apps.map((a) => (
                <AppTile key={a.id} app={a} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
