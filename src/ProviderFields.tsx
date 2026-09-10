import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import type { ProviderProfile } from './types';
import { api } from './lib';
import { Button, ErrorBox, Field, Input, TextArea, Select } from './components';

const split = (value: string) => [...new Set(value.split(/[,，\s]+/).filter(Boolean))];
type DiscoveryConnection = { base_url: string; secret?: string; channel_id?: string; provider_id?: string };
export function ProviderFields({ value, onChange, discovery, onLoadingChange, readOnly = false }: {
  value: ProviderProfile; onChange: (value: ProviderProfile) => void; readOnly?: boolean;
  discovery: DiscoveryConnection; onLoadingChange: (loading: boolean) => void;
}) {
  const [tags, setTags] = useState(value.tags.join(', ')), [models, setModels] = useState(value.models.join('\n'));
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const controller = useRef<AbortController | null>(null);
  const latest = useRef({ value, onChange, onLoadingChange });
  latest.current = { value, onChange, onLoadingChange };
  const connectionKey = JSON.stringify({ ...discovery, protocol: value.protocol });
  useEffect(() => {
    controller.current?.abort(); controller.current = null;
    setLoading(false); setError(''); setStatus(''); latest.current.onLoadingChange(false);
    return () => { controller.current?.abort(); controller.current = null; };
  }, [connectionKey]);
  async function fetchModels() {
    const request = new AbortController(); controller.current = request;
    setLoading(true); onLoadingChange(true); setError(''); setStatus('');
    try {
      const result = await api<{ models: string[] }>('/providers/models', {
        method: 'POST', signal: request.signal, body: JSON.stringify({ ...discovery, protocol: value.protocol }),
      });
      if (controller.current !== request) return;
      const current = latest.current.value, merged = [...new Set([...current.models, ...result.models])];
      if (merged.length > 1000) throw new Error('合并后超过 1000 个模型，请先精简当前清单后重试');
      setModels(merged.join('\n')); latest.current.onChange({ ...current, models: merged });
      setStatus(`已获取 ${result.models.length} 个模型，新增 ${merged.length - current.models.length} 个；保存后生效。`);
    } catch (err) { if (controller.current === request) setError((err as Error).message); }
    finally {
      if (controller.current === request) { controller.current = null; setLoading(false); latest.current.onLoadingChange(false); }
    }
  }
  return <>
    <Field label="服务商协议" hint="按供应商实际接口选择；网关自动转换客户端请求，并使用相应协议的认证方式。"><Select disabled={readOnly} value={value.protocol} onChange={protocol => onChange({ ...value, protocol: protocol as ProviderProfile['protocol'] })}><option value="openai">OpenAI 兼容 · Chat Completions</option><option value="anthropic">Anthropic · Messages</option></Select></Field>
    <Field label="服务商标签" hint="用逗号分隔，例如 production, claude。API Key 可按这些标签限制访问。"><Input disabled={readOnly} value={tags} onChange={e => { setTags(e.target.value); onChange({ ...value, tags: split(e.target.value) }); }} placeholder="production, claude" /></Field>
    <Field label="服务商模型清单" hint="每行一个上游模型 ID，最多 1000 个。获取结果自动去重并合并，保留已填写的模型；保存后自动建立同名路由。">
      <div className="model-discovery-toolbar"><Button type="button" variant="secondary" disabled={readOnly || loading || !discovery.base_url.trim()} onClick={fetchModels}>{loading ? <LoaderCircle size={15} className="animate-spin" /> : <Download size={15} />}{loading ? '正在获取…' : '从上游获取'}</Button><span className="muted">GET /v1/models</span></div>
      <TextArea disabled={readOnly || loading} rows={6} value={models} onChange={e => { setModels(e.target.value); setStatus(''); onChange({ ...value, models: split(e.target.value) }); }} placeholder={'claude-sonnet-4-5\nclaude-opus-4-6'} />
    </Field>
    <ErrorBox message={error} />
    {status && <div className="info-note" role="status">{status}</div>}
  </>;
}
