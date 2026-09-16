import { useContext, useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { GatewaySettings } from '../shared/gateway-settings';
import { api, RefreshContext, ToastContext } from './lib';
import { Button, ErrorBox, Field, Input, Select } from './components';
import './runtime-settings.css';

export function RuntimeSettings({ initial }: { initial: GatewaySettings }) {
  const [value, setValue] = useState(initial), [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const notify = useContext(ToastContext), { refresh } = useContext(RefreshContext);
  const dirty = JSON.stringify(value) !== JSON.stringify(saved);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api<GatewaySettings>('/config/runtime', { method: 'PUT', body: JSON.stringify(value) });
      setSaved(result); setValue(result); refresh(); notify('程序设置已保存，后续请求生效');
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  function updateRule(index: number, update: Partial<GatewaySettings['upstream_error_rules'][number]>) {
    setValue(previous => ({ ...previous, upstream_error_rules: previous.upstream_error_rules.map((rule, i) => i === index ? { ...rule, ...update } : rule) }));
  }
  return <form className="runtime-settings" onSubmit={submit}>
    <section className="runtime-section"><div className="runtime-section-heading"><h2>负载均衡</h2><p>先按路由组优先级选择可用组，再使用以下策略分配同优先级组的请求。</p></div>
      <Field label="组分配策略"><Select value={value.load_balancing} disabled={busy} onChange={strategy => setValue({ ...value, load_balancing: strategy as GatewaySettings['load_balancing'] })}><option value="random">随机选择组</option><option value="weighted">按照权重</option></Select></Field>
      <p className="runtime-hint">{value.load_balancing === 'weighted' ? '使用「模型与路由」中的组权重。同优先级组的权重越高，被选中的概率越大。' : '同优先级的可用组具有相同的选择概率，不使用组权重。'}选中组后，按组内路由优先级与该组的分配策略选择上游。</p>
      <p className="runtime-hint">每个组可独立选择随机、按照权重或轮询。未分组路由归入默认组，组内继续沿用此处的策略。</p>
    </section>
    <section className="runtime-section"><div className="runtime-section-heading"><h2>重试配置</h2><p>重试次数不包含首次请求。已尝试的渠道不会再次被选为新渠道。</p></div>
      <div className="runtime-columns"><Field label="单渠道最大重试次数" hint="0–5 次。临时故障时先重试当前渠道，再尝试其他渠道。"><Input type="number" required min={0} max={5} step={1} disabled={busy} value={value.same_channel_retries} onChange={event => setValue({ ...value, same_channel_retries: Number(event.target.value) })} /></Field>
      <Field label="跨渠道最大重试次数" hint="0–10 次。失败后最多切换多少个不同渠道；设为 0 则不切换。"><Input type="number" required min={0} max={10} step={1} disabled={busy} value={value.cross_channel_retries} onChange={event => setValue({ ...value, cross_channel_retries: Number(event.target.value) })} /></Field></div>
      <div className="runtime-summary">最多尝试 <strong>{value.cross_channel_retries + 1}</strong> 个渠道、<strong>{(value.same_channel_retries + 1) * (value.cross_channel_retries + 1)}</strong> 次上游请求<span>受可用渠道数限制，每次按渠道超时独立计时</span></div>
      <p className="runtime-hint">较高的重试次数可能增加延迟。鉴权失败、模型不可用会直接切换渠道；一般参数错误不重试。开始流式输出后不再重试。</p>
    </section>
    <section className="runtime-section"><div className="runtime-section-heading"><h2>上游错误展示</h2><p>控制 API 用户看到的报错内容，适用于普通响应和流式响应。</p></div>
      <Field label="展示方式"><Select value={value.upstream_error_mode} disabled={busy} onChange={mode => setValue({ ...value, upstream_error_mode: mode as GatewaySettings['upstream_error_mode'] })}><option value="hide">隐藏细节</option><option value="show">显示原始错误</option><option value="custom">根据错误码自定义</option></Select></Field>
      <p className="runtime-hint">{value.upstream_error_mode === 'show' ? '将供应商的原始错误信息返回给 API 用户。' : value.upstream_error_mode === 'hide' ? '返回统一提示和请求 ID，不展示供应商的错误详情。' : '优先匹配供应商错误码，再匹配 HTTP 状态码；未匹配时隐藏细节。只替换提示内容，不改变 HTTP 状态。'}</p>
      {value.upstream_error_mode === 'custom' && <div className="runtime-rules"><div className="runtime-rules-heading"><span>错误映射 <small>{value.upstream_error_rules.length} / 50</small></span><Button type="button" variant="secondary" disabled={busy || value.upstream_error_rules.length >= 50} onClick={() => setValue({ ...value, upstream_error_rules: [...value.upstream_error_rules, { code: '', message: '' }] })}><Plus size={14} />添加规则</Button></div>
        {!value.upstream_error_rules.length && <p className="runtime-hint">添加错误码与对外提示，例如 429 →「请求较多，请稍后重试」。</p>}
        {value.upstream_error_rules.map((rule, index) => <div className="runtime-rule" key={index}><Field label={`错误码 ${index + 1}`}><Input required disabled={busy} maxLength={100} placeholder="429 / rate_limit_exceeded" value={rule.code} onChange={event => updateRule(index, { code: event.target.value })} /></Field><Field label="对外提示"><Input required disabled={busy} maxLength={1000} placeholder="请求较多，请稍后重试" value={rule.message} onChange={event => updateRule(index, { message: event.target.value })} /></Field><Button type="button" variant="ghost" className="icon-btn" aria-label={`删除错误规则 ${index + 1}`} disabled={busy} onClick={() => setValue({ ...value, upstream_error_rules: value.upstream_error_rules.filter((_, i) => i !== index) })}><Trash2 size={15} /></Button></div>)}
      </div>}
      <p className="runtime-hint">管理员可在「请求日志 → 请求追踪」查看原始错误，保留 7 天，每条最多 16 KiB；超出部分会标记截断。</p>
    </section>
    <ErrorBox message={error} /><div className="runtime-save"><span>{dirty ? '有未保存的更改' : '保存后对新请求生效'}</span><Button type="button" variant="secondary" disabled={busy || !dirty} onClick={() => { setValue(saved); setError(''); }}>撤销更改</Button><Button type="submit" disabled={busy || !dirty}>{busy ? '保存中…' : '保存设置'}</Button></div>
  </form>;
}
