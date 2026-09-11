import '../models.css';
import { useContext, useEffect, useState, type FormEvent } from 'react';
import { ChevronRight, GitBranch, Plus, Search, Trash2 } from 'lucide-react';
import type { Model, Route, Channel } from '../types';
import { api, useApi, RefreshContext, ToastContext } from '../lib';
import { matchesRouteScope, routeScopeQuery, scopeModels, type RouteScope } from '../../shared/route-scope';
import { Badge, Button, Confirm, Empty, ErrorBox, Field, Loading, Modal, Toggle, Input, Select, FormSection } from '../components';

type ModelScope = Exclude<RouteScope, { kind: 'all' }>;

function RouteForm({ modelId: initialModelId, route, channels, models, scope, onClose }: { modelId: string; route: Route | null; channels: Channel[]; models: Model[]; scope: ModelScope; onClose: () => void }) {
  const [modelId, setModelId] = useState(initialModelId || models[0]?.id || '');
  const [channelId, setChannelId] = useState(route?.channel_id || channels[0]?.id || ''), [upstream, setUpstream] = useState(route?.upstream_model || '');
  const [priority, setPriority] = useState(route?.priority || 0), [weight, setWeight] = useState(route?.weight || 1);
  const [enabled, setEnabled] = useState(route ? !!route.enabled : true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await api(`/routes${route ? `/${route.id}` : ''}${routeScopeQuery(scope)}`, { method: route ? 'PUT' : 'POST', body: JSON.stringify({ model_id: modelId, channel_id: channelId, upstream_model: upstream, priority, weight, enabled, input_price: route?.input_price ?? null, output_price: route?.output_price ?? null }) }); refresh(); notify('路由已保存'); onClose(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <Modal title={route ? '编辑路由' : '添加路由'} description={`${initialModelId ? `为 ${modelId} 配置路由；` : ''}仅管理${scope.kind === 'tag' ? `标签 ${scope.tag}` : '未打标签渠道'}的路由。`} onClose={onClose}><form onSubmit={submit} className="form-stack"><FormSection number="01" title="上游目标">{!initialModelId && <Field label="应用模型 ID" hint="为已有模型添加当前标签的路由。新模型可在渠道模型清单中添加，并启用自动建立同名路由。"><Select required value={modelId} onChange={setModelId}><option value="" disabled>选择模型</option>{models.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}</Select></Field>}<Field label="目标渠道"><Select required value={channelId} onChange={value => setChannelId(value)}><option value="" disabled>选择渠道</option>{channels.map(c => <option key={c.id} value={c.id}>{c.name}{!c.configured ? '（待配置）' : ''}</option>)}</Select></Field><Field label="上游模型 ID" hint="Cloudflare AI 使用 openai/gpt-4.1 或 @cf/…；自定义服务商使用供应商原始模型 ID。"><Input required value={upstream} onChange={e => setUpstream(e.target.value)} placeholder="openai/gpt-4.1" /></Field></FormSection><FormSection number="02" title="分配策略"><div className="form-columns"><Field label="优先级" hint="数值越小越先使用"><Input type="number" required min={0} max={1000} value={priority} onChange={e => setPriority(Number(e.target.value))} /></Field><Field label="权重" hint="按权重策略下，同优先级按此权重分配"><Input type="number" required min={1} max={1000} value={weight} onChange={e => setWeight(Number(e.target.value))} /></Field></div></FormSection><div className="info-note">费用由 Cloudflare AI Gateway 统计。自定义模型如需补充单价，请在 Cloudflare 配置 Custom costs。</div><Toggle checked={enabled} onChange={setEnabled} label="启用此路由" /><ErrorBox message={error} /><div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button disabled={busy || !channels.length || !modelId}>{busy ? '保存中…' : '保存路由'}</Button></div></form></Modal>;
}
export function Models() {
  const models = useApi<Model[]>('/models'), channels = useApi<Channel[]>('/channels');
  const [requestedScopeValue, setScopeValue] = useState('');
  const tags = [...new Set(channels.data?.flatMap(channel => channel.tags) || [])].sort();
  const scopeOptions = [
    ...tags.map(tag => ({ value: `tag:${tag}`, label: tag })),
    ...(channels.data?.some(channel => channel.tags.length === 0) ? [{ value: 'untagged', label: '未打标签' }] : []),
  ];
  const scopeValue = scopeOptions.some(option => option.value === requestedScopeValue) ? requestedScopeValue : scopeOptions[0]?.value;
  const scope: ModelScope | null = !scopeValue ? null : scopeValue === 'untagged' ? { kind: 'untagged' } : { kind: 'tag', tag: scopeValue.slice(4) };
  const scopedChannels = scope ? channels.data?.filter(channel => matchesRouteScope(channel.tags, scope)) || [] : [];
  const scopedModels = scope ? scopeModels(models.data || [], new Set(scopedChannels.map(channel => channel.id)), scope) : [];
  const ready = !!models.data && !!channels.data;
  const canAddRoute = !!scope && !!scopedChannels.length && !!models.data?.length;
  const [search, setSearch] = useState(''), [routeEdit, setRouteEdit] = useState<{ modelId: string; route: Route | null; scope: ModelScope } | null>(null);
  const [deleting, setDeleting] = useState<{ path: string; name: string } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  const [selectedId, setSelectedId] = useState('');
  useEffect(() => {
    if (scopeValue) setScopeValue(scopeValue);
    setSearch('');
  }, [scopeValue]);
  const filtered = scopedModels.filter(m => `${m.id} ${m.description}`.toLowerCase().includes(search.toLowerCase()));
  const selected = filtered?.find(model => model.id === selectedId) || filtered?.[0];
  async function remove() {
    setBusy(true); setError('');
    try { await api(deleting!.path, { method: 'DELETE' }); refresh(); setDeleting(null); notify('已删除'); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <div className="models-page">
    <header className="models-page-heading"><div><div className="models-page-title"><h1>模型与路由</h1><span className="models-count">{ready ? scopedModels.length : '—'}</span><span className="models-scope-summary">{ready ? `${scopedChannels.length} 个渠道 · ${scopedModels.reduce((total, model) => total + model.routes.length, 0)} 条路由` : '—'}</span></div><p>管理当前标签的模型与上游路由</p></div><Button disabled={!canAddRoute} onClick={() => scope && setRouteEdit({ modelId: '', route: null, scope })}><Plus size={16} />添加模型路由</Button></header>
    {!!scopeOptions.length && <div className="model-scope-bar">
      <div className="model-scope-options" role="group" aria-label="按服务商标签管理模型路由">{scopeOptions.map(option => <Button key={option.value} type="button" variant="ghost" className="model-scope-tag" aria-pressed={scopeValue === option.value} onClick={() => { if (scopeValue !== option.value) { setScopeValue(option.value); setSearch(''); } }}>{option.label}</Button>)}</div>
    </div>}
    <ErrorBox message={models.error || channels.error} />
    <div className="model-workspace surface">
      <aside className="model-directory"><div className="directory-heading"><h2>模型目录</h2><span>{search ? `${filtered?.length ?? 0} / ` : ''}{ready ? scopedModels.length : '—'}</span></div><div className="search-field"><Search size={16} /><Input aria-label="搜索模型" placeholder="搜索模型或描述" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <div className="model-options" role="group" aria-label="选择模型">{filtered?.map(model => <button type="button" className={`model-option ${selected?.id === model.id ? 'selected' : ''}`} key={model.id} onClick={() => setSelectedId(model.id)} aria-pressed={selected?.id === model.id}><span className="model-option-copy"><strong title={model.id}>{model.id}</strong><small><i className={model.enabled ? 'is-enabled' : ''} />{model.routes.length} 条路由 · {model.enabled ? '已启用' : '已停用'}</small></span><ChevronRight size={14} /></button>)}</div>
        <div className="directory-foot"><GitBranch size={15} />优先级路由 / 负载均衡</div>
      </aside>
      <section className="routing-workspace">{(models.loading && !models.data) || (channels.loading && !channels.data) ? <Loading /> : selected && scope ? <>
        <header className="routing-heading"><div className="routing-model-copy"><div className="routing-model-title"><h2>{selected.id}</h2><Badge tone={selected.enabled ? 'green' : 'neutral'}>{selected.enabled ? '已启用' : '全局停用'}</Badge></div>{selected.description && <p>{selected.description}</p>}</div>
        </header>
        <div className="routing-toolbar"><div><h3>上游路由</h3><span>{selected.routes.length} 条</span></div><Button variant="secondary" onClick={() => setRouteEdit({ modelId: selected.id, route: null, scope })}><Plus size={15} />添加路由</Button></div>
        {selected.routes.length ? <div className="route-table-scroll" key={selected.id} role="region" aria-label={`${selected.id} 的上游路由`} tabIndex={0}><table className="route-table"><colgroup><col className="route-col-model" /><col className="route-col-channel" /><col className="route-col-priority" /><col className="route-col-weight" /><col className="route-col-state" /><col className="route-col-actions" /></colgroup><thead><tr><th scope="col">上游模型</th><th scope="col">渠道 / 协议</th><th scope="col" className="route-numeric">优先级</th><th scope="col" className="route-numeric">权重</th><th scope="col">状态</th><th scope="col" className="route-actions-heading">操作</th></tr></thead><tbody>{[...selected.routes].sort((a, b) => a.priority - b.priority).map(route => {
          const channel = channels.data?.find(channel => channel.id === route.channel_id);
          return <tr key={route.id} className={route.enabled ? '' : 'route-disabled'}><td><code className="route-upstream" title={route.upstream_model}>{route.upstream_model}</code></td><td><span className="route-channel" title={channel?.name || route.channel_id}>{channel?.name || route.channel_id}</span><span className={`route-protocol ${channel?.protocol === 'anthropic' ? 'is-anthropic' : ''}`}>{channel ? channel.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容' : '—'}</span></td><td className="route-numeric"><span className="priority-token">P{route.priority}</span></td><td className="route-numeric">{route.weight}</td><td><span className={`route-status ${route.enabled ? 'is-enabled' : ''}`}><i />{route.enabled ? '启用' : '停用'}</span></td><td><div className="route-row-actions"><Button variant="ghost" className="route-edit" aria-label={`编辑路由 ${route.upstream_model}`} onClick={() => setRouteEdit({ modelId: selected.id, route, scope })}>编辑</Button><Button variant="ghost" className="icon-btn route-delete" aria-label={`删除路由 ${route.upstream_model}`} onClick={() => { setError(''); setDeleting({ path: `/routes/${route.id}${routeScopeQuery(scope)}`, name: route.upstream_model }); }}><Trash2 size={15} /></Button></div></td></tr>;
        })}</tbody></table></div> : <Empty title="为模型添加一条路径" description="连接上游渠道后，应用才可以调用这个模型。" action={<Button variant="secondary" onClick={() => setRouteEdit({ modelId: selected.id, route: null, scope })}><Plus size={16} />添加路由</Button>} />}
        <div className="routing-explainer"><GitBranch size={14} /><p>API Key 只使用其授权标签内的路由。渠道有多个标签时，同一路由的修改会影响这些标签。</p></div>
      </> : <Empty title={search ? '没有匹配的模型' : scope ? '当前标签下还没有模型路由' : '请先添加渠道'} description={search ? '试试其他模型 ID 或描述。' : scope ? '为已有模型添加当前标签的渠道路由，或在渠道模型清单中添加模型并启用自动建立同名路由。' : '在渠道管理中添加渠道并设置标签，然后管理对应的模型路由。'} action={!search && (canAddRoute ? <Button variant="secondary" onClick={() => scope && setRouteEdit({ modelId: '', route: null, scope })}><Plus size={16} />添加模型路由</Button> : <Button variant="secondary" onClick={() => { window.location.hash = 'channels'; }}>前往渠道管理</Button>)} />}</section>
    </div>
    {routeEdit && <RouteForm {...routeEdit} models={models.data || []} channels={(channels.data || []).filter(channel => matchesRouteScope(channel.tags, routeEdit.scope))} onClose={() => setRouteEdit(null)} />}
    {deleting && <Confirm title={`删除 ${deleting.name}？`} description="后续请求不再使用此路由。" onConfirm={remove} onClose={() => setDeleting(null)} busy={busy} error={error} />}
  </div>;
}
