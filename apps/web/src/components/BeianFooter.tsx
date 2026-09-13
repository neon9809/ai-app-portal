import type { BrandingInfo } from '@aap/shared';

/** 项目主页（页脚未配置文案时的默认署名链接） */
const PROJECT_URL = 'https://github.com/neon9809/ai-app-portal';

/** 页脚：署名（未配置文案时默认展示「AI应用门户」并链接项目主页）+ ICP + 公安备案组件。 */
export function BeianFooter({ branding }: { branding: BrandingInfo }) {
  const year = new Date().getFullYear();
  const icp = branding.icpNumber?.trim();
  const police = branding.policeNumber?.trim();
  const policeDigits = police ? police.replace(/\D/g, '') : '';
  const attribution = branding.footerText?.trim() ? (
    <span>{branding.footerText}</span>
  ) : (
    <a href={PROJECT_URL} target="_blank" rel="noreferrer noopener">
      AI应用门户
    </a>
  );
  return (
    <footer className="aap-footer">
      {attribution}
      {icp || police ? <span> · </span> : null}
      {icp ? (
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer noopener">
          {icp}
        </a>
      ) : null}
      {icp && police ? <span> · </span> : null}
      {police && policeDigits ? (
        <a
          href={`https://beian.mps.gov.cn/#/query/webSearch?code=${encodeURIComponent(policeDigits)}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          <span style={{ marginRight: 4 }}>🛡</span>
          {police}
        </a>
      ) : null}
      <div style={{ marginTop: 4 }}>
        © {year}{' '}
        {branding.footerText?.trim() ? (
          <span>{branding.siteName}</span>
        ) : (
          <a href={PROJECT_URL} target="_blank" rel="noreferrer noopener">
            {branding.siteName}
          </a>
        )}
      </div>
    </footer>
  );
}
