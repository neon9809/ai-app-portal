import { ColorPicker, Select, Space, Button, theme as antdTheme } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { UserOutlined, LogoutOutlined } from '@ant-design/icons';
import type { PortalBootstrap } from '@aap/shared';
import { api } from '../api/client';
import { BUILTIN_THEMES, useTheme } from '../theme/themes';
import { BeianFooter } from '../components/BeianFooter';
import { useSession, useLogout } from '../state/session';

/**
 * 门户 shell：品牌头（logo/站名/标语）+ 主题切换（W1 演示位，W7 收进用户菜单）
 * + 会话区（登录按钮 / 用户菜单含 个人中心+退出登录——统一 chrome）+ 备案页脚。
 */
export function PortalLayout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api<PortalBootstrap>('/api/portal/bootstrap'),
  });
  const { me } = useSession();
  const logout = useLogout();
  const { themeId, accent, setThemeId, setAccent } = useTheme();
  const { token } = antdTheme.useToken();

  const branding = data?.branding;

  return (
    <div className="aap-shell">
      <header className="aap-header">
        <Link to="/" style={{ textDecoration: 'none' }}>
          <div className="aap-brand">
            {branding?.logo ? (
              <img src={branding.logo} alt={branding.siteName} />
            ) : (
              <span
                style={{
                  display: 'inline-flex',
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  background: token.colorPrimary,
                  color: '#fff',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                }}
              >
                {branding?.siteName?.[0] ?? 'A'}
              </span>
            )}
            <span className="aap-site-name">{branding?.siteName ?? 'AI应用门户'}</span>
          </div>
        </Link>
        {branding?.tagline ? <span className="aap-tagline">{branding.tagline}</span> : null}
        <div style={{ flex: 1 }} />
        <Space size="small" wrap={false}>
          <Select
            size="small"
            value={themeId}
            onChange={setThemeId}
            style={{ width: 120 }}
            options={BUILTIN_THEMES.map((t) => ({ value: t.id, label: t.name }))}
            aria-label="选择主题"
          />
          <ColorPicker
            size="small"
            value={accent ?? undefined}
            onChange={(c) => setAccent(c.toHexString())}
            onClear={() => setAccent(null)}
            allowClear
            showText={false}
          />
          {me ? (
            <>
              <Button
                size="small"
                icon={<UserOutlined />}
                onClick={() => {
                  void qc.invalidateQueries();
                  navigate('/account');
                }}
              >
                {me.user.name}
              </Button>
              <Button size="small" icon={<LogoutOutlined />} onClick={() => void logout()} aria-label="退出登录" />
            </>
          ) : (
            <Button size="small" type="primary" icon={<UserOutlined />}>
              <Link to="/login" style={{ color: 'inherit' }}>
                登录
              </Link>
            </Button>
          )}
        </Space>
      </header>
      <main className="aap-main">
        <Outlet />
      </main>
      {branding ? <BeianFooter branding={branding} /> : null}
    </div>
  );
}
