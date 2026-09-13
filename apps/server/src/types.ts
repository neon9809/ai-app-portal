/**
 * Express Request 扩展字段：
 *  - user：sessionMiddleware 装载的会话用户（未登录为 undefined/null）
 *  - clientIp：getClientIp 的结果（TRUST_PROXY 语义生效后的真实客户端 IP）
 *  - userRoles：预留（M1 RBAC 简化为 user.role，此字段保留兼容扩展）
 */
import type { AuthState, UserRole, UserKind } from '@aap/shared';

export interface SessionUser {
  id: number;
  avatar?: string | null;
  kind: UserKind;
  /** 'local:<username>'（oidc: 'oidc:<subject>'，M2） */
  subject: string;
  username: string | null;
  email: string | null;
  phone: string | null;
  name: string;
  role: UserRole;
  status: string;
  /** 会话 token 的 SHA-256（会话列表/踢下线用） */
  sessionId: string;
  /** 登录状态机：password_ok → mfa_pending → full */
  authState: AuthState;
  /** 步升认证到期时间（null 未步升） */
  stepUpUntil: number | null;
  /** 会员计划（M3 计费；M1 恒 free） */
  plan: 'free' | 'member';
  /** 是否已启用 MFA（任一第二因子） */
  mfaEnabled: boolean;
  /** 强制改密标记（首始 F3 / 管理员重置后） */
  mustChangePassword: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser | null;
      userRoles?: string[];
      clientIp?: string;
    }
  }
}

export {};
