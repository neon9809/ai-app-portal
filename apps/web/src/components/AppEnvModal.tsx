/**
 * 应用环境变量 / 机密配置弹窗（G6）。
 * 管理后台（应用管理）与用户中心（我的应用）共用：
 *  - 列出 manifest.env 声明：必填/可选、密钥/普通、描述与格式校验提示
 *  - 普通变量可查看当前值；机密只显示「已设置 ••••1234」，留空提交 = 不修改
 *  - 保存经 PUT /api/apps/:id/env，值加密落盘并在沙箱启动时注入
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Empty, Input, Modal, Space, Spin, Tag, Typography, message } from 'antd';
import { api } from '../api/client';

interface EnvVarView {
  name: string;
  required: boolean;
  secret: boolean;
  description: string;
  pattern: string | null;
  default: string | null;
  configured: boolean;
  value?: string;
  hint?: string;
}

interface EnvData {
  declared: EnvVarView[];
  undeclared: string[];
}

export function AppEnvModal({ appId, appName, open, onClose }: { appId: string; appName: string; open: boolean; onClose: () => void }): ReactNode {
  const [data, setData] = useState<EnvData | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // 普通变量：受控输入（初值 = 当前值）；机密：空串表示不修改
  const [values, setValues] = useState<Record<string, string>>({});
  const [secretClears, setSecretClears] = useState<Record<string, boolean>>({});

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<EnvData>(`/api/apps/${encodeURIComponent(appId)}/env`);
      setData(r);
      const init: Record<string, string> = {};
      for (const v of r.declared) init[v.name] = v.secret ? '' : (v.value ?? '');
      setValues(init);
      setSecretClears({});
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载环境变量失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, appId]);

  async function save(): Promise<void> {
    if (!data) return;
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const v of data.declared) {
        if (v.secret) {
          if (secretClears[v.name]) payload[v.name] = '';
          else if (values[v.name]) payload[v.name] = values[v.name]!; // 留空 = 不修改
        } else {
          payload[v.name] = values[v.name] ?? ''; // 普通变量空串 = 清除
        }
      }
      const r = await api<{ saved: string[]; cleared: string[] }>(`/api/apps/${encodeURIComponent(appId)}/env`, {
        method: 'PUT',
        json: { values: payload },
      });
      const n = r.saved.length + r.cleared.length;
      message.success(n > 0 ? '已保存，下次沙箱启动生效' : '无变更');
      onClose();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  const hasVars = (data?.declared.length ?? 0) > 0 || (data?.undeclared.length ?? 0) > 0;

  return (
    <Modal
      title={`环境变量：${appName}`}
      open={open}
      onCancel={onClose}
      width={640}
      footer={
        hasVars
          ? [
              <Button key="cancel" onClick={onClose}>
                取消
              </Button>,
              <Button key="save" type="primary" loading={saving} onClick={() => void save()}>
                保存
              </Button>,
            ]
          : [
              <Button key="close" type="primary" onClick={onClose}>
                知道了
              </Button>,
            ]
      }
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      ) : !hasVars ? (
        <Empty description="该包的 manifest 未声明任何环境变量" />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            值加密存储；沙箱（按调用执行 / 持久服务）启动时注入为进程环境变量。机密变量保存后不可再查看。
          </Typography.Paragraph>
          {data!.declared.map((v) => (
            <div key={v.name}>
              <Space size="small" wrap style={{ marginBottom: 4 }}>
                <Typography.Text code strong>
                  {v.name}
                </Typography.Text>
                <Tag color={v.required ? 'orange' : 'default'} style={{ fontSize: 11 }}>
                  {v.required ? '必填' : '可选'}
                </Tag>
                {v.secret ? (
                  <Tag color="purple" style={{ fontSize: 11 }}>
                    密钥
                  </Tag>
                ) : null}
                {v.description ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {v.description}
                  </Typography.Text>
                ) : null}
              </Space>
              {v.secret ? (
                <Space.Compact style={{ width: '100%' }}>
                  <Input.Password
                    value={secretClears[v.name] ? '' : values[v.name] ?? ''}
                    placeholder={v.configured ? `已设置 ${v.hint ?? ''}（留空保持不变）` : '未设置，请输入'}
                    onChange={(e) => {
                      setValues((p) => ({ ...p, [v.name]: e.target.value }));
                      if (secretClears[v.name]) setSecretClears((p) => ({ ...p, [v.name]: false }));
                    }}
                    autoComplete="new-password"
                  />
                  {v.configured ? (
                    <Button
                      danger={secretClears[v.name]}
                      onClick={() => setSecretClears((p) => ({ ...p, [v.name]: !p[v.name] }))}
                    >
                      {secretClears[v.name] ? '取消清除' : '清除'}
                    </Button>
                  ) : null}
                </Space.Compact>
              ) : (
                <Input
                  value={values[v.name] ?? ''}
                  placeholder={v.default != null ? `默认值：${v.default}` : '未设置'}
                  onChange={(e) => setValues((p) => ({ ...p, [v.name]: e.target.value }))}
                />
              )}
              {v.pattern ? (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  格式校验：{v.pattern}
                </Typography.Text>
              ) : null}
            </div>
          ))}
          {data!.undeclared.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={`以下变量已存储但当前包版本不再声明（可忽略，或重新配置同名变量以清除）：${data!.undeclared.join('、')}`}
            />
          ) : null}
        </Space>
      )}
    </Modal>
  );
}
