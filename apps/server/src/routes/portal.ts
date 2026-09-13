import { Router } from 'express';
import { sql } from 'drizzle-orm';
import type { PortalBootstrap, RegistrationMode } from '@aap/shared';
import { getDb } from '../db/index.js';
import { users } from '../db/schema.js';
import { getSetting } from '../lib/settings.js';
import { oidcEnabled } from '../lib/oidc.js';

/**
 * 门户公共引导信息（未登录可读）：品牌数据（A1）+ 注册开关状态 + 初始化标记。
 * 管理端改品牌/注册策略后下次拉取即生效（保存即生效，E2-⑦）。
 */
export const portalRouter = Router();

const REGISTRATION_MODES: RegistrationMode[] = ['closed', 'open', 'invite'];

portalRouter.get('/portal/bootstrap', (_req, res) => {
  const mode = (getSetting('REGISTRATION_MODE') ?? 'closed') as RegistrationMode;
  const bootstrap: PortalBootstrap = {
    branding: {
      siteName: getSetting('SITE_NAME') || 'AI应用门户',
      tagline: getSetting('SITE_TAGLINE') || '',
      logo: getSetting('LOGO') || null,
      themeId: getSetting('THEME_ID') || 'ocean',
      accentColor: getSetting('ACCENT_COLOR') || null,
      footerText: getSetting('FOOTER_TEXT') || '',
      icpNumber: getSetting('ICP_NUMBER') || null,
      policeNumber: getSetting('POLICE_NUMBER') || null,
    },
    registration: {
      mode: REGISTRATION_MODES.includes(mode) ? mode : 'closed',
      turnstileEnabled: Boolean(getSetting('TURNSTILE_SITE_KEY')),
    },
    needsInit: (getDb().select({ n: sql<number>`count(*)` }).from(users).get()?.n ?? 0) === 0,
    oidc: { enabled: oidcEnabled() },
  };
  res.json(bootstrap);
});
