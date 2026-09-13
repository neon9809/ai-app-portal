import type { BrandingInfo } from '@aap/shared';

/** ICP + 公安备案组件（A1）：号码组件化、自动带官方查询链接；留空不显示。 */
export function BeianFooter({ branding }: { branding: BrandingInfo }) {
  const year = new Date().getFullYear();
  const icp = branding.icpNumber?.trim();
  const police = branding.policeNumber?.trim();
  const policeDigits = police ? police.replace(/\D/g, '') : '';
  return (
    <footer className="aap-footer">
      {branding.footerText ? <span>{branding.footerText}</span> : null}
      {branding.footerText && (icp || police) ? <span> · </span> : null}
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
        © {year} {branding.siteName}
      </div>
    </footer>
  );
}
