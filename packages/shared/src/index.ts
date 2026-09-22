/**
 * @aap/shared — 前后端共享类型与 API 契约（单一来源）。
 *
 * 原则：本包只放「契约」——类型、常量、纯函数；不放任何依赖 Node/浏览器
 * 运行时的代码。前后端都从这里 import，避免契约漂移。
 */

// ---------- API 错误契约 ----------

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    /** 需要客户端补充动作（如 pow 挑战 / mfa 挑战 / 步升认证）时给出 */
    action?: string;
    [k: string]: unknown;
  };
}

// ---------- 用户与会话 ----------

export type UserKind = 'local' | 'oidc';
export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled' | 'deletion_pending' | 'pending_approval';
export type AuthState = 'password_ok' | 'mfa_pending' | 'full';

/** 门户自身用户（不含任何凭据字段，凭据不下发） */
export interface PublicUser {
  id: number;
  kind: UserKind;
  username: string | null;
  email: string | null;
  phone: string | null;
  name: string;
  avatar: string | null;
  role: UserRole;
  status: UserStatus;
  mfaEnabled: boolean;
  /** M3 接入：会员计划（free/member），M1 恒为 free */
  plan: 'free' | 'member';
  createdAt: number;
}

/** 登录态下的会话信息（/api/auth/me 等返回） */
export interface SessionInfo {
  user: PublicUser;
  authState: AuthState;
  /** 敏感操作步升认证的到期时间（未步升为 null） */
  stepUpUntil: number | null;
  /** 强制流程标记：改密 / 绑 MFA（首始 F3 用） */
  mustChangePassword: boolean;
  mustEnrollMfa: boolean;
}

// ---------- 门户品牌（A1，数据化品牌） ----------

export interface BrandingInfo {
  siteName: string;
  tagline: string;
  logo: string | null;
  themeId: string;
  /** 自定义强调色（覆盖主题强调色），null 用主题默认 */
  accentColor: string | null;
  footerText: string;
  /** ICP 备案号（组件自动带工信部查询链接） */
  icpNumber: string | null;
  /** 公安备案号（组件自动带公安备案查询链接） */
  policeNumber: string | null;
}

/** 注册开关三档：closed 关闭 / open 开放 / invite 开放+邀请码 */
export type RegistrationMode = 'closed' | 'open' | 'invite';

/** 门户公共引导信息（未登录可读） */
export interface PortalBootstrap {
  branding: BrandingInfo;
  registration: {
    mode: RegistrationMode;
    turnstileEnabled: boolean;
  };
  /** 首个账号尚未创建 → 前端引导「初始化管理员」流程 */
  needsInit: boolean;
  /** OIDC 单点登录是否已配置启用 */
  oidc: { enabled: boolean };
}

// ---------- 应用（B4 / 门户卡片墙） ----------

export type AppVisibility = 'public' | 'login' | 'restricted' | 'private';
export type AppStatus = 'ok' | 'down' | 'unknown';

/** 卡片墙 / 列表用的应用公开视图（不含 upstream/urlSecret 等敏感字段） */
export interface AppCard {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  category: string;
  visibility: AppVisibility;
  /** 当前用户是否可访问（服务端按会话计算） */
  accessible: boolean;
  status: AppStatus;
  sort: number;
  /** 应用形态（python 包的执行入口区分） */
  kind?: 'upstream' | 'html' | 'package';
  runtimeMode?: 'invoked' | 'persistent' | null;
};

// ---------- 常量 ----------

/** 平台版本（随根 package.json 同步） */
export const AAP_VERSION = '0.1.2';

/** 身份注入头（passUser；移植自参考实现，剥离单位指纹后更名） */
export const IDENTITY_HEADER = 'x-aap-identity';
export const IDENTITY_SIG_HEADER = 'x-aap-identity-sig';
/** 身份头 TTL：10 分钟 */
export const IDENTITY_TTL_MS = 10 * 60 * 1000;

/** 会话 cookie 名 */
export const SESSION_COOKIE = 'aap_sid';

export const APP_PATH_PREFIX = '/app';

/** 内置主题 id 契约（web 端 theme 包实现，品牌 settings 引用 id） */
export const BUILTIN_THEME_IDS = [
  'ocean',
  'aurora',
  'forest',
  'sunset',
  'sakura',
  'graphite',
] as const;
export type BuiltinThemeId = (typeof BUILTIN_THEME_IDS)[number];
