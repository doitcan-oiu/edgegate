import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Tag, TagGroup } from '@heroui/react';
import { LoaderCircle, X } from 'lucide-react';
import type { ProviderProfile } from './types';
import { api } from './lib';
import { MAX_PROVIDER_MODELS, mergeModelInput } from './model-input';
import { Button, ErrorBox, Field, Input, Select, Toggle } from './components';

const split = (value: string) => [...new Set(value.split(/[,，\s]+/).filter(Boolean))];
type DiscoveryConnection = { base_url: string; secret?: string; channel_id?: string; provider_id?: string };
export type ProviderFieldsHandle = { commitModels: () => ProviderProfile | null };
export function ProviderFields({ value, onChange, discovery, onLoadingChange, readOnly = false, routeCreation, ref }: {
  value: ProviderProfile; onChange: (value: ProviderProfile) => void; readOnly?: boolean;
  discovery: DiscoveryConnection; onLoadingChange: (loading: boolean) => void;
  ref?: Ref<ProviderFieldsHandle>;
  routeCreation?: { enabled: boolean; onChange: (enabled: boolean) => void };
}) {
  const [tags, setTags] = useState(value.tags.join(', ')), [modelInput, setModelInput] = useState('');
  const [modelError, setModelError] = useState('');
  const modelErrorId = useId();
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const controller = useRef<AbortController | null>(null);
  const modelEditor = useRef<HTMLDivElement>(null);
  const latest = useRef({ value, onChange, onLoadingChange });
  latest.current = { value, onChange, onLoadingChange };
  const connectionKey = JSON.stringify({ ...discovery, protocol: value.protocol });
  function commitModels(input = modelInput): ProviderProfile | null {
    const current = latest.current.value;
    const result = mergeModelInput(current.models, input);
    if (result.error !== undefined) {
      setModelError(result.error);
      modelEditor.current?.querySelector('input')?.focus();
      return null;
    }
    setModelInput(''); setModelError('');
    if (!input.trim()) return current;
    const next = result.added ? { ...current, models: result.models } : current;
    if (next !== current) { latest.current.value = next; latest.current.onChange(next); }
    setStatus(result.added ? `已添加 ${result.added} 个模型；保存后生效。` : '输入的模型已在清单中。');
    return next;
  }
  useImperativeHandle(ref, () => ({ commitModels }));
  useEffect(() => {
    controller.current?.abort(); controller.current = null;
    setLoading(false); setError(''); setStatus(''); latest.current.onLoadingChange(false);
    return () => { controller.current?.abort(); controller.current = null; };
  }, [connectionKey]);
  async function fetchModels() {
    const profile = commitModels();
    if (!profile) return;
    const request = new AbortController(); controller.current = request;
    setLoading(true); onLoadingChange(true); setError(''); setStatus('');
    try {
      const result = await api<{ models: string[] }>('/providers/models', {
        method: 'POST', signal: request.signal, body: JSON.stringify({ ...discovery, protocol: profile.protocol }),
      });
      if (controller.current !== request) return;
      const current = latest.current.value, merged = [...new Set([...current.models, ...result.models])];
      if (merged.length > MAX_PROVIDER_MODELS) throw new Error('合并后超过 1000 个模型，请先精简当前清单后重试');
      latest.current.onChange({ ...current, models: merged });
      setStatus(`已获取 ${result.models.length} 个模型，新增 ${merged.length - current.models.length} 个；保存后生效。`);
    } catch (err) { if (controller.current === request) setError((err as Error).message); }
    finally {
      if (controller.current === request) { controller.current = null; setLoading(false); latest.current.onLoadingChange(false); }
    }
  }
  return <>
    <Field label="服务商协议" hint="按供应商实际接口选择；网关自动转换客户端请求，并使用相应协议的认证方式。"><Select disabled={readOnly} value={value.protocol} onChange={protocol => onChange({ ...value, protocol: protocol as ProviderProfile['protocol'] })}><option value="openai">OpenAI 兼容 · Chat Completions</option><option value="anthropic">Anthropic · Messages</option></Select></Field>
    <Field label="服务商标签" hint="用逗号分隔，例如 production, claude。API Key 可按这些标签限制访问。"><Input disabled={readOnly} value={tags} onChange={e => { setTags(e.target.value); onChange({ ...value, tags: split(e.target.value) }); }} placeholder="production, claude" /></Field>
    <Field label="服务商模型清单" hint="输入模型 ID 后按回车添加，也可粘贴多行或用逗号分隔。最多 1000 个，自动去重。">
      <div className="model-discovery-toolbar"><Button type="button" variant="secondary" disabled={readOnly || loading || !discovery.base_url.trim()} onClick={fetchModels}>{loading && <LoaderCircle size={15} strokeWidth={1.5} className="animate-spin" />}{loading ? '正在获取…' : '从上游获取'}</Button><span className="muted">GET /v1/models</span></div>
      <div className="model-tag-editor" ref={modelEditor} aria-busy={loading}>
        <div className="model-tag-input">
          <Input disabled={readOnly || loading} value={modelInput} aria-invalid={!!modelError} aria-errormessage={modelError ? modelErrorId : undefined} autoComplete="off" spellCheck={false} placeholder="输入模型 ID，按 Enter 添加"
            onChange={e => { setModelInput(e.target.value); setModelError(''); setStatus(''); }}
            onKeyDown={e => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              e.preventDefault();
              commitModels();
            }}
            onPaste={e => {
              const pasted = e.clipboardData.getData('text');
              if (!/[,，\s]/.test(pasted)) return;
              e.preventDefault();
              const start = e.currentTarget.selectionStart ?? modelInput.length, end = e.currentTarget.selectionEnd ?? start;
              const input = `${modelInput.slice(0, start)}${pasted}${modelInput.slice(end)}`;
              if (!commitModels(input)) setModelInput(input.replace(/\s+/g, ' '));
            }} />
          <Button type="button" variant="secondary" disabled={readOnly || loading || !modelInput.trim()} onClick={() => { if (commitModels()) modelEditor.current?.querySelector('input')?.focus(); }}>添加</Button>
        </div>
        {!!value.models.length && <TagGroup className="model-tag-group" aria-label="已添加的服务商模型" selectionMode="none" disabledKeys={readOnly || loading ? value.models : []}
          onRemove={keys => {
            if (readOnly || loading) return;
            const current = latest.current.value;
            const next = { ...current, models: current.models.filter(model => !keys.has(model)) };
            latest.current.value = next; latest.current.onChange(next); setStatus(''); setModelError('');
            if (!next.models.length) modelEditor.current?.querySelector('input')?.focus();
          }}>
          <TagGroup.List className="model-tag-list">{value.models.map(model => <Tag key={model} id={model} textValue={model} className="model-tag">
            <span className="model-tag-text" title={model}>{model}</span><Tag.RemoveButton type="button" aria-label={`移除模型 ${model}`} isDisabled={readOnly || loading}><X size={13} strokeWidth={1.5} /></Tag.RemoveButton>
          </Tag>)}</TagGroup.List>
        </TagGroup>}
        <div className="model-tag-count" aria-live="polite">已添加 {value.models.length} / {MAX_PROVIDER_MODELS} 个模型</div>
      </div>
      {modelError && <div id={modelErrorId}><ErrorBox message={modelError} /></div>}
    </Field>
    {routeCreation && <div className="model-routing-option">
      <Toggle label="自动建立同名路由" checked={routeCreation.enabled} onChange={routeCreation.onChange} disabled={readOnly} />
      <p>{routeCreation.enabled ? '保存后为此渠道建立同名模型与路由，后续随模型清单同步。' : '仅保存模型清单，已有路由保持不变。可在「模型与路由」中手动配置。'}</p>
    </div>}
    <ErrorBox message={error} />
    {status && <div className="info-note" role="status">{status}</div>}
  </>;
}
