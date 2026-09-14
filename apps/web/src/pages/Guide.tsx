/**
 * 开发指南（R2）：登录用户可见（含沙箱模型/审核流程等，不再对匿名开放——P2-12）。
 *  - 「应用开发规范」：app-develop skill.md 全文 + 一键复制（开发 Agent 的输入契约）
 *  - 「平台说明」：仅管理员可见（README + 平台实现约定）
 */
import { Alert, Button, Card, Tabs, Typography, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSession } from '../state/session';
import { api } from '../api/client';

interface GuideResponse {
  skillMd: string;
}
interface DocsResponse {
  docs: Array<{ title: string; file: string; content: string }>;
}

function CopyButton({ text, label = '一键复制' }: { text: string; label?: string }): ReactNode {
  return (
    <Button
      type="primary"
      icon={<CopyOutlined />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          message.success(`已复制${label === '一键复制' ? '' : label}到剪贴板（${text.length.toLocaleString()} 字符）`);
        } catch {
          message.error('复制失败：请检查浏览器剪贴板权限');
        }
      }}
    >
      {label}
    </Button>
  );
}

function DocViewer({ content }: { content: string }): ReactNode {
  return (
    <pre
      style={{
        margin: 0,
        padding: 16,
        background: 'var(--aap-bg-layout)',
        border: '1px solid var(--aap-border)',
        borderRadius: 8,
        fontSize: 12.5,
        lineHeight: 1.65,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: '68vh',
        overflow: 'auto',
      }}
    >
      {content}
    </pre>
  );
}

export function GuidePage() {
  const { me } = useSession();
  const guide = useQuery({
    queryKey: ['dev-guide'],
    queryFn: () => api<GuideResponse>('/api/dev/guide'),
    enabled: Boolean(me),
    staleTime: 300_000,
  });
  const isAdmin = me?.user.role === 'admin';
  const docs = useQuery({
    queryKey: ['dev-docs'],
    queryFn: () => api<DocsResponse>('/api/dev/docs'),
    enabled: isAdmin,
    staleTime: 300_000,
  });

  if (!me) {
    return (
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <Typography.Title level={4}>开发指南</Typography.Title>
        <Alert type="info" showIcon message="开发指南仅登录用户可见，请先登录。" />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <Typography.Title level={4}>开发指南</Typography.Title>
      <Typography.Paragraph type="secondary">
        想给门户写一个新应用？把下面的「应用开发规范」整段复制给任何编码 Agent（ZCode / Claude 等），
        它会按规范产出一个 <code>.neon-aap</code> 包，上传到门户即可安装使用。
      </Typography.Paragraph>

      <Tabs
        items={[
          {
            key: 'skill',
            label: '应用开发规范（skill.md）',
            children: guide.isLoading ? (
              <Typography.Text type="secondary">加载中…</Typography.Text>
            ) : guide.data ? (
              <Card
                size="small"
                title="app-develop.skill · v0.2 · 供开发 Agent 使用"
                extra={<CopyButton text={guide.data.skillMd} />}
              >
                <DocViewer content={guide.data.skillMd} />
              </Card>
            ) : (
              <Typography.Text type="danger">指南文件缺失（部署包未包含）。</Typography.Text>
            ),
          },
          ...(isAdmin
            ? [
                {
                  key: 'docs',
                  label: '平台说明（管理员）',
                  children: docs.data ? (
                    <Tabs
                      items={docs.data.docs.map((d) => ({
                        key: d.file,
                        label: d.title,
                        children: (
                          <Card size="small" title={d.file} extra={<CopyButton text={d.content} label="复制全文" />}>
                            <DocViewer content={d.content} />
                          </Card>
                        ),
                      }))}
                    />
                  ) : (
                    <Typography.Text type="secondary">加载中…</Typography.Text>
                  ),
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}
