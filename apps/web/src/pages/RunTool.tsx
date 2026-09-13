/** .neon-aap invoked 工具执行页（G5）：入参表单 → 沙箱运行 → 结果渲染。 */
import { Alert, Button, Card, Input, Spin, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';

interface RunMeta {
  id: string;
  name: string;
  description: string;
  kind: string;
  runtimeMode: string | null;
  inputSchema: unknown;
}

interface FieldSpec {
  name: string;
  label?: string;
  type?: 'string' | 'number' | 'text';
  required?: boolean;
  default?: string | number;
}

interface RunResponse {
  status: 'ok' | 'error' | 'timeout';
  result: unknown;
  error: string | null;
  logs: string;
  durationMs: number;
}

export function RunToolPage() {
  const { id = '' } = useParams();
  const [meta, setMeta] = useState<RunMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [jsonInput, setJsonInput] = useState('{}');
  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState<RunResponse | null>(null);

  const load = useCallback(async () => {
    try {
      const m = await api<RunMeta>(`/api/apps/${id}/meta`);
      setMeta(m);
      // inputSchema：字段数组 [{name,label,type,required,default}]；未配置 → JSON 输入
      if (Array.isArray(m.inputSchema)) {
        const initial: Record<string, string> = {};
        for (const f of m.inputSchema as FieldSpec[]) {
          initial[f.name] = f.default !== undefined ? String(f.default) : '';
        }
        setValues(initial);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Alert type="error" showIcon message={error} />;
  if (!meta) return <Spin style={{ display: 'block', margin: '80px auto' }} />;

  const fields = Array.isArray(meta.inputSchema) ? (meta.inputSchema as FieldSpec[]) : null;

  async function run(): Promise<void> {
    setRunning(true);
    setResponse(null);
    try {
      let input: unknown = {};
      if (fields) {
        input = { ...values };
        for (const f of fields) {
          if (f.type === 'number') (input as Record<string, unknown>)[f.name] = Number(values[f.name] ?? 0);
        }
      } else {
        input = JSON.parse(jsonInput || '{}');
      }
      const r = await api<RunResponse>(`/api/apps/${id}/run`, { method: 'POST', json: { input } });
      setResponse(r);
    } catch (err) {
      setResponse({ status: 'error', result: null, error: err instanceof Error ? err.message : '运行失败', logs: '', durationMs: 0 });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <Typography.Title level={4}>{meta.name}</Typography.Title>
      {meta.description ? <Typography.Paragraph type="secondary">{meta.description}</Typography.Paragraph> : null}

      <Card size="small" title="输入" style={{ marginBottom: 16 }}>
        {fields ? (
          <div style={{ display: 'grid', gap: 10 }}>
            {fields.map((f) => (
              <div key={f.name}>
                <div style={{ fontSize: 12, color: 'var(--aap-text-secondary)', marginBottom: 4 }}>{f.label ?? f.name}</div>
                {f.type === 'text' ? (
                  <Input.TextArea
                    rows={3}
                    value={values[f.name] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  />
                ) : (
                  <Input
                    value={values[f.name] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  />
                )}
              </div>
            ))}
          </div>
        ) : (
          <Input.TextArea
            rows={6}
            value={jsonInput}
            onChange={(e) => setJsonInput(e.target.value)}
            placeholder='{"key": "value"}'
            style={{ fontFamily: 'monospace' }}
          />
        )}
        <Button type="primary" style={{ marginTop: 12 }} loading={running} onClick={() => void run()}>
          运行
        </Button>
      </Card>

      {response ? (
        <Card size="small" title={`结果（${response.durationMs}ms）`}>
          {response.status !== 'ok' ? (
            <Alert type="error" showIcon message={response.error ?? '运行失败'} style={{ marginBottom: 10 }} />
          ) : null}
          <pre
            style={{
              margin: 0,
              padding: 12,
              background: 'var(--aap-bg-layout)',
              border: '1px solid var(--aap-border)',
              borderRadius: 8,
              fontSize: 12.5,
              whiteSpace: 'pre-wrap',
              maxHeight: '50vh',
              overflow: 'auto',
            }}
          >
            {typeof response.result === 'object' && response.result !== null
              ? JSON.stringify(response.result, null, 2)
              : String(response.result ?? '')}
          </pre>
          {response.logs ? (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--aap-text-secondary)' }}>运行日志</summary>
              <pre style={{ fontSize: 11.5, whiteSpace: 'pre-wrap' }}>{response.logs}</pre>
            </details>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
