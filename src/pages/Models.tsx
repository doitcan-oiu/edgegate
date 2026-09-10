import { useContext, useState, type FormEvent } from 'react';
import { ArrowRight, Box, ChevronDown, GitBranch, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import type { Model, Route, Channel } from '../types';
import { api, useApi, RefreshContext, ToastContext } from '../lib';
import { Badge, Button, Confirm, Empty, ErrorBox, Field, Loading, Modal, PageTitle, Toggle, Input, Select, FormSection } from '../components';

function ModelForm({ model, onClose }: { model: Model | null; onClose: () => void }) {
  const [id, setId] = useState(model?.id || ''), [description, setDescription] = useState(model?.description || ''), [enabled, setEnabled] = useState(model ? !!model.enabled : true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await api(`/models${model ? `/${encodeURIComponent(model.id)}` : ''}`, { method: model ? 'PUT' : 'POST', body: JSON.stringify({ id, description, enabled }) }); refresh(); notify('模型已保存'); onClose(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <Modal title={model ? '编辑模型' : '添加模型'} description="应用使用这个模型 ID 发起请求，网关负责映射到上游。" onClose={onClose}><form className="form-stack" onSubmit={submit}><FormSection number="01" title="模型入口"><Field label="模型 ID"><Input required maxLength={160} disabled={!!model} value={id} onChange={e => setId(e.target.value)} placeholder="例如：smart-chat" autoFocus /></Field><Field label="描述"><Input value={description} maxLength={300} onChange={e => setDescription(e.target.value)} placeholder="模型的用途或说明" /></Field></FormSection><Toggle checked={enabled} onChange={setEnabled} label="允许调用此模型" /><ErrorBox message={error} /><div className="modal-actions"><Button variant="secondary" type="button" onClick={onClose}>取消</Button><Button disabled={busy}>{busy ? '保存中…' : '保存模型'}</Button></div></form></Modal>;
}
function RouteForm({ modelId, route, channels, onClose }: { modelId: string; route: Route | null; channels: Channel[]; onClose: () => void }) {
  const [channelId, setChannelId] = useState(route?.channel_id || channels[0]?.id || ''), [upstream, setUpstream] = useState(route?.upstream_model || '');
  const [priority, setPriority] = useState(route?.priority || 0), [weight, setWeight] = useState(route?.weight || 1);
  const [enabled, setEnabled] = useState(route ? !!route.enabled : true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await api(`/routes${route ? `/${route.id}` : ''}`, { method: route ? 'PUT' : 'POST', body: JSON.stringify({ model_id: modelId, channel_id: channelId, upstream_model: upstream, priority, weight, enabled }) }); refresh(); notify('路由已保存'); onClose(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <Modal title={route ? '编辑路由' : '添加路由'} description={`为 ${modelId} 选择上游模型。`} onClose={onClose}><form onSubmit={submit} className="form-stack"><FormSection number="01" title="上游目标"><Field label="目标渠道"><Select required value={channelId} onChange={value => setChannelId(value)}><option value="" disabled>选择渠道</option>{channels.map(c => <option key={c.id} value={c.id}>{c.name}{!c.configured ? '（待配置）' : ''}</option>)}</Select></Field><Field label="上游模型 ID" hint="Cloudflare AI 使用 openai/gpt-4.1 或 @cf/…；自定义服务商使用供应商原始模型 ID。"><Input required value={upstream} onChange={e => setUpstream(e.target.value)} placeholder="openai/gpt-4.1" /></Field></FormSection><FormSection number="02" title="分配策略"><div className="form-columns"><Field label="优先级" hint="数值越小越先使用"><Input type="number" required min={0} max={1000} value={priority} onChange={e => setPriority(Number(e.target.value))} /></Field><Field label="权重" hint="同优先级按权重分配"><Input type="number" required min={1} max={1000} value={weight} onChange={e => setWeight(Number(e.target.value))} /></Field></div></FormSection><div className="info-note">费用由 Cloudflare AI Gateway 统计。自定义模型如需补充单价，请在 Cloudflare 配置 Custom costs。</div><Toggle checked={enabled} onChange={setEnabled} label="启用此路由" /><ErrorBox message={error} /><div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button disabled={busy || !channels.length}>{busy ? '保存中…' : '保存路由'}</Button></div></form></Modal>;
}
export function Models() {
  const models = useApi<Model[]>('/models'), channels = useApi<Channel[]>('/channels');
  const [search, setSearch] = useState(''), [editing, setEditing] = useState<Model | null | undefined>(), [routeEdit, setRouteEdit] = useState<{ modelId: string; route: Route | null } | null>(null);
  const [deleting, setDeleting] = useState<{ path: string; name: string; model: boolean } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  const [selectedId, setSelectedId] = useState('');
  const filtered = models.data?.filter(m => `${m.id} ${m.description}`.toLowerCase().includes(search.toLowerCase()));
  const selected = filtered?.find(model => model.id === selectedId) || filtered?.[0];
  async function remove() {
    setBusy(true); setError('');
    try { await api(deleting!.path, { method: 'DELETE' }); refresh(); setDeleting(null); notify('已删除'); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <>
    <PageTitle eyebrow="03 / MODEL REGISTRY" title="模型与路由" description="一个模型 ID，多条上游路径。" action={<Button onClick={() => setEditing(null)}><Plus size={17} />添加模型</Button>} />
    <ErrorBox message={models.error || channels.error} />
    <div className="model-workspace surface">
      <aside className="model-directory"><div className="directory-heading"><h2>模型目录</h2><Badge>{models.data?.length ?? '—'}</Badge></div><div className="search-field"><Search size={17} /><Input aria-label="搜索模型" placeholder="搜索模型或描述" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <div className="model-options" role="group" aria-label="选择模型">{filtered?.map(model => <button type="button" className={`model-option ${selected?.id === model.id ? 'selected' : ''}`} key={model.id} onClick={() => setSelectedId(model.id)} aria-pressed={selected?.id === model.id}><span className="model-option-icon"><Box size={19} /></span><span><strong>{model.id}</strong><small>{model.routes.length} 条路由 · {model.enabled ? '已启用' : '已停用'}</small></span><ChevronDown size={16} /></button>)}</div>
        <div className="directory-foot"><GitBranch size={15} />优先级路由 / 加权分配</div>
      </aside>
      <section className="routing-workspace">{models.loading && !models.data ? <Loading /> : selected ? <>
        <div className="routing-heading"><div><span className="eyebrow">APPLICATION MODEL</span><h2>{selected.id}</h2><p>{selected.description || '这个模型 ID 是应用请求的统一入口。'}</p></div><Badge tone={selected.enabled ? 'green' : 'neutral'}>{selected.enabled ? '已启用' : '已停用'}</Badge></div>
        <div className="routing-actions"><Button variant="secondary" onClick={() => setRouteEdit({ modelId: selected.id, route: null })}><Plus size={16} />添加路由</Button><Button variant="ghost" onClick={() => setEditing(selected)}><Pencil size={15} />编辑模型</Button><Button variant="ghost" className="icon-btn danger-text" aria-label={`删除模型 ${selected.id}`} onClick={() => { setError(''); setDeleting({ path: `/models/${encodeURIComponent(selected.id)}`, name: selected.id, model: true }); }}><Trash2 size={17} /></Button></div>
        <div className="routing-flow-label"><span className="signal-dot" />应用请求<span className="flow-line" /><GitBranch size={16} />路由选择<span className="flow-line" />上游模型</div>
        <div className="route-stack">{selected.routes.length ? [...selected.routes].sort((a, b) => a.priority - b.priority).map(route => {
          const channel = channels.data?.find(channel => channel.id === route.channel_id);
          return <article className="route-node" key={route.id}><div className="route-node-top"><span className="priority-token">P{route.priority}</span><strong>{channel?.name || route.channel_id}</strong><Badge tone={route.enabled ? 'green' : 'neutral'}>{route.enabled ? '启用' : '停用'}</Badge></div><div className="route-destination"><ArrowRight size={20} /><code>{route.upstream_model}</code></div><div className="route-node-bottom"><span>{channel?.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}<i />权重 {route.weight}</span><div><Button variant="ghost" className="icon-btn" aria-label={`编辑路由 ${route.upstream_model}`} onClick={() => setRouteEdit({ modelId: selected.id, route })}><Pencil size={16} /></Button><Button variant="ghost" className="icon-btn danger-text" aria-label={`删除路由 ${route.upstream_model}`} onClick={() => { setError(''); setDeleting({ path: `/routes/${route.id}`, name: route.upstream_model, model: false }); }}><Trash2 size={16} /></Button></div></div></article>;
        }) : <Empty title="为模型添加一条路径" description="连接上游渠道后，应用才可以调用这个模型。" action={<Button variant="secondary" onClick={() => setRouteEdit({ modelId: selected.id, route: null })}><Plus size={16} />添加路由</Button>} />}</div>
        <div className="routing-explainer"><GitBranch size={19} /><p>优先级数值越小越先使用；同优先级按权重分配。上游异常时尝试下一条路由，开始流式输出后不再重试。</p></div>
      </> : <Empty title={search ? '没有匹配的模型' : '建立第一个模型入口'} description="创建模型别名，统一应用调用方式。" action={!search && <Button onClick={() => setEditing(null)}><Plus size={17} />添加模型</Button>} />}</section>
    </div>
    {editing !== undefined && <ModelForm model={editing} onClose={() => setEditing(undefined)} />}
    {routeEdit && <RouteForm {...routeEdit} channels={channels.data || []} onClose={() => setRouteEdit(null)} />}
    {deleting && <Confirm title={`删除 ${deleting.name}？`} description={deleting.model ? '此模型的所有路由也将删除，调用该模型的应用会受到影响。' : '后续请求不再使用此路由。'} onConfirm={remove} onClose={() => setDeleting(null)} busy={busy} error={error} />}
  </>;
}
