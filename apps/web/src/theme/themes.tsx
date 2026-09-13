/**
 * 主题系统：≥6 套内置主题（A1），方法论复用 fnos-dashboard：
 * 主题 = 一组 design token（CSS variables + AntD token 双写），
 * 品牌数据（settings.THEME_ID/ACCENT_COLOR）只引用 id，切换实时生效。
 * TS 是单一来源；CSS 变量由 ThemeProvider 写入 :root，自定义样式消费。
 */
import { ConfigProvider, theme as antdTheme, type ThemeConfig } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BUILTIN_THEME_IDS, type BuiltinThemeId, type PortalBootstrap } from '@aap/shared';
import { api } from '../api/client';

export interface AapThemeColors {
  primary: string;
  accent: string;
  bgLayout: string;
  bgContainer: string;
  bgElevated: string;
  text: string;
  textSecondary: string;
  border: string;
}

export interface AapTheme {
  id: BuiltinThemeId;
  name: string;
  dark: boolean;
  colors: AapThemeColors;
}

export const BUILTIN_THEMES: AapTheme[] = [
  {
    id: 'ocean',
    name: '海雾蓝',
    dark: false,
    colors: {
      primary: '#1E5AA8',
      accent: '#13C2C2',
      bgLayout: '#F2F6FB',
      bgContainer: '#FFFFFF',
      bgElevated: '#FFFFFF',
      text: '#17233D',
      textSecondary: '#5A6A85',
      border: '#D8E1EC',
    },
  },
  {
    id: 'aurora',
    name: '极光青',
    dark: false,
    colors: {
      primary: '#0E9F8A',
      accent: '#7B61FF',
      bgLayout: '#F0FAF8',
      bgContainer: '#FFFFFF',
      bgElevated: '#FFFFFF',
      text: '#10322D',
      textSecondary: '#557A73',
      border: '#CFE8E2',
    },
  },
  {
    id: 'forest',
    name: '松林绿',
    dark: false,
    colors: {
      primary: '#2E7D32',
      accent: '#F5A623',
      bgLayout: '#F4FAF3',
      bgContainer: '#FFFFFF',
      bgElevated: '#FFFFFF',
      text: '#1B2E1C',
      textSecondary: '#5C735E',
      border: '#D3E4D4',
    },
  },
  {
    id: 'sunset',
    name: '暖阳橙',
    dark: false,
    colors: {
      primary: '#D46B08',
      accent: '#1677FF',
      bgLayout: '#FDF6EF',
      bgContainer: '#FFFFFF',
      bgElevated: '#FFFFFF',
      text: '#3D2B1F',
      textSecondary: '#8C6F5C',
      border: '#F0DECB',
    },
  },
  {
    id: 'sakura',
    name: '樱粉',
    dark: false,
    colors: {
      primary: '#C2477E',
      accent: '#531DAB',
      bgLayout: '#FBF3F7',
      bgContainer: '#FFFFFF',
      bgElevated: '#FFFFFF',
      text: '#33182A',
      textSecondary: '#8A5F77',
      border: '#F0D6E3',
    },
  },
  {
    id: 'graphite',
    name: '石墨（暗色）',
    dark: true,
    colors: {
      primary: '#4C8DFF',
      accent: '#36CFC9',
      bgLayout: '#14171C',
      bgContainer: '#1D2129',
      bgElevated: '#23272F',
      text: '#E6E8EC',
      textSecondary: '#9AA3B2',
      border: '#2E333D',
    },
  },
];

export function getTheme(id: string | null | undefined): AapTheme {
  return BUILTIN_THEMES.find((t) => t.id === id) ?? BUILTIN_THEMES[0]!;
}

function cssVarName(k: keyof AapThemeColors): string {
  return `--aap-${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`;
}

function applyCssVars(theme: AapTheme, accent: string | null): void {
  const root = document.documentElement;
  const colors = accent ? { ...theme.colors, accent } : theme.colors;
  for (const [k, v] of Object.entries(colors)) {
    root.style.setProperty(cssVarName(k as keyof AapThemeColors), v);
  }
  root.dataset.aapTheme = theme.id;
}

const LS_THEME = 'aap.theme';
const LS_ACCENT = 'aap.accent';

interface ThemeContextValue {
  theme: AapTheme;
  themeId: string;
  accent: string | null;
  setThemeId: (id: string) => void;
  setAccent: (c: string | null) => void;
  /** 清除个人偏好，回到管理员配置的默认主题 */
  resetPersonal: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return v;
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  // R3 主题归属：默认主题/强调色由管理员在后台配置（settings，经 bootstrap 下发）；
  // 用户在本页（个人中心-外观）做的选择写入 localStorage，仅覆盖本人浏览器。
  const boot = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api<PortalBootstrap>('/api/portal/bootstrap'),
    staleTime: 60_000,
    retry: 1,
  });
  const [personalThemeId, setPersonalThemeId] = useState<string | null>(() => localStorage.getItem(LS_THEME));
  const [personalAccent, setPersonalAccent] = useState<string | null>(() => localStorage.getItem(LS_ACCENT));

  const themeId = personalThemeId ?? boot.data?.branding.themeId ?? 'ocean';
  const accent = personalAccent ?? boot.data?.branding.accentColor ?? null;
  const theme = getTheme(themeId);

  useEffect(() => {
    applyCssVars(theme, accent);
  }, [theme, accent]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      themeId,
      accent,
      setThemeId: (id: string) => {
        localStorage.setItem(LS_THEME, id);
        setPersonalThemeId(id);
      },
      setAccent: (c: string | null) => {
        if (c) localStorage.setItem(LS_ACCENT, c);
        else localStorage.removeItem(LS_ACCENT);
        setPersonalAccent(c);
      },
      /** 清除个人偏好，回到管理员配置的默认 */
      resetPersonal: () => {
        localStorage.removeItem(LS_THEME);
        localStorage.removeItem(LS_ACCENT);
        setPersonalThemeId(null);
        setPersonalAccent(null);
      },
    }),
    [theme, themeId, accent],
  );

  const antdConfig = useMemo<ThemeConfig>(() => {
    const primary = accent ?? theme.colors.primary;
    return {
      algorithm: theme.dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: primary,
        colorInfo: primary,
        colorBgLayout: theme.colors.bgLayout,
        colorBgContainer: theme.colors.bgContainer,
        colorBgElevated: theme.colors.bgElevated,
        colorText: theme.colors.text,
        colorTextSecondary: theme.colors.textSecondary,
        colorBorder: theme.colors.border,
        colorBorderSecondary: theme.colors.border,
        borderRadius: 8,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
      },
    };
  }, [theme, accent]);

  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider locale={zhCN} theme={antdConfig}>
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}

/** 主题 id 契约校验（服务端 settings 只存 id） */
export function isBuiltinThemeId(id: string): id is BuiltinThemeId {
  return (BUILTIN_THEME_IDS as readonly string[]).includes(id);
}
