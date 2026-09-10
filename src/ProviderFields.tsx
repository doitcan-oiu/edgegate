import { useState } from 'react';
import type { ProviderProfile } from './types';
import { Field, Input, TextArea, Select } from './components';

const split = (value: string) => [...new Set(value.split(/[,，\s]+/).filter(Boolean))];
export function ProviderFields({ value, onChange, readOnly = false }: { value: ProviderProfile; onChange: (value: ProviderProfile) => void; readOnly?: boolean }) {
  const [tags, setTags] = useState(value.tags.join(', ')), [models, setModels] = useState(value.models.join('\n'));
  return <>
    <div className="info-note">协议、标签和模型清单在当前 EdgeGate 工作空间生效。</div>
    <Field label="服务商协议" hint="按供应商实际接口选择；网关自动转换客户端请求，并使用相应协议的认证方式。"><Select disabled={readOnly} value={value.protocol} onChange={protocol => onChange({ ...value, protocol: protocol as ProviderProfile['protocol'] })}><option value="openai">OpenAI 兼容 · Chat Completions</option><option value="anthropic">Anthropic · Messages</option></Select></Field>
    <Field label="服务商标签" hint="用逗号分隔，例如 production, claude。API Key 可按这些标签限制访问。"><Input disabled={readOnly} value={readOnly ? value.tags.join(', ') : tags} onChange={e => { setTags(e.target.value); onChange({ ...value, tags: split(e.target.value) }); }} placeholder="production, claude" /></Field>
    <Field label="服务商模型清单" hint="每行一个上游模型 ID。关联渠道后自动建立同名路由；同标签服务商的模型合并展示。同名模型自动去重。"><TextArea disabled={readOnly} rows={4} value={readOnly ? value.models.join('\n') : models} onChange={e => { setModels(e.target.value); onChange({ ...value, models: split(e.target.value) }); }} placeholder={'claude-sonnet-4-5\nclaude-opus-4-6'} /></Field>
    {readOnly && <div className="info-note">协议、标签和模型清单在“Cloudflare 服务商”页签统一编辑，对本程序内所有关联渠道生效。</div>}
  </>;
}
