import '../models.css';
import { ComboBox, ListBox } from '@heroui/react';
import { PROTOCOL_LABELS } from '../../shared/protocols';
import { useContext, useEffect, useState, type FormEvent } from 'react';
import { ChevronRight, GitBranch, Layers3, Plus, Search, Trash2 } from 'lucide-react';
import type { Model, Route, RouteGroup, Channel } from '../types';
import { api, useApi, RefreshContext, ToastContext } from '../lib';
import { matchesRouteScope, routeScopeQuery, routeScopeTags, scopeModels, type RouteScope } from '../../shared/route-scope';
import { Badge, Button, Confirm, Empty, ErrorBox, Field, Loading, Modal, Toggle, Input, Select, FormSection } from '../components';

type ModelScope = Exclude<RouteScope, { kind: 'all' }>;
const STRATEGY_LABELS = { random: '随机', weighted: '按照权重', round_robin: '轮询' } as const;
const DEFAULT_GROUP = '__default__';

function ModelPicker({ models, value, onChange, busy, hint }: { models: Model[]; value: string; onChange: (value: string) => void; busy: boolean; hint: string }) {
  return <Field label="应用模型 ID" hint={hint}>
    <ComboBox className="route-model-picker" aria-label="应用模型 ID" allowsCustomValue allowsEmptyCollection isRequired isDisabled={busy} defaultItems={models} value={models.some(model => model.id === value) ? value : null} inputValue={value} onInputChange={onChange} onChange={key => { if (key !== null) onChange(String(key)); }}>
      <ComboBox.InputGroup><Input required placeholder="输入新模型 ID 或选择已有模型" /><ComboBox.Trigger aria-label="展开已有模型" /></ComboBox.InputGroup>
      <ComboBox.Popover className="route-model-options"><ListBox renderEmptyState={() => <span className="route-model-empty">{value ? '新模型 ID 将在保存时创建' : '暂无模型，可直接输入新模型 ID'}</span>}>{(model: Model) => <ListBox.Item id={model.id} textValue={model.id}><span>{model.id}</span><ListBox.ItemIndicator /></ListBox.Item>}</ListBox></ComboBox.Popover>
    </ComboBox>
  </Field>;
}

function RouteForm({ modelId: initialModelId, groupId: initialGroupId, route, channels, models, scope, onClose, onSaved }: { modelId: string; groupId?: string | null; route: Route | null; channels: Channel[]; models: Model[]; scope: ModelScope; onClose: () => void; onSaved: (modelId: string) => void }) {
  const [modelId, setModelId] = useState(initialModelId);
  const [groupId, setGroupId] = useState(route?.group_id || initialGroupId || DEFAULT_GROUP);
  const [channelId, setChannelId] = useState(route?.channel_id || channels[0]?.id || ''), [upstream, setUpstream] = useState(route?.upstream_model || initialModelId);
  const [priority, setPriority] = useState(route?.priority || 0), [weight, setWeight] = useState(route?.weight || 1);
  const [enabled, setEnabled] = useState(route ? !!route.enabled : true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const groups = models.find(model => model.id === modelId.trim())?.groups || [];
  const selectedGroup = groups.find(group => group.id === groupId);
  const missingGroup = groupId !== DEFAULT_GROUP && !selectedGroup;
  const targetChannel = channels.find(channel => channel.id === channelId);
  const explicitTag = route?.scope_tag || (scope.kind === 'tag' && targetChannel && !matchesRouteScope(targetChannel.tags, scope) ? scope.tag : '');
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (missingGroup) { setError('所选路由组已变化，请重新选择'); return; }
    setBusy(true); setError('');
    try {
      await api(`/routes${route ? `/${route.id}` : ''}${routeScopeQuery(scope)}`, { method: route ? 'PUT' : 'POST', body: JSON.stringify({ model_id: modelId.trim(), ...(!route && { create_model: true }), group_id: selectedGroup?.id || null, channel_id: channelId, upstream_model: upstream, priority, weight, enabled, input_price: route?.input_price ?? null, output_price: route?.output_price ?? null }) });
      refresh(); notify('路由已保存'); onSaved(modelId.trim()); onClose();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <Modal title={route ? '编辑路由' : '添加路由'} description={`${initialModelId ? `为 ${modelId} 配置路由；` : ''}管理${scope.kind === 'tag' ? `标签 ${scope.tag} 的路由，可选择其他标签的渠道作为上游` : '未打标签渠道的路由'}。`} onClose={onClose}>
    <form onSubmit={submit} className="form-stack">
      <FormSection number="01" title="上游目标">
        {!initialModelId && <ModelPicker models={models} value={modelId} onChange={value => { setModelId(value); setGroupId(DEFAULT_GROUP); }} busy={busy} hint="输入新 ID，保存时创建应用模型并添加路由；选择已有 ID 则只添加路由。" />}
        <Field label="目标渠道" hint={scope.kind === 'tag' ? '可跨标签选择；仅所选模型通过此路由获得访问权限。' : undefined}><Select required value={channelId} onChange={setChannelId} disabled={busy}><option value="" disabled>选择渠道</option>{channels.map(c => <option key={c.id} value={c.id}>{c.name} · {c.tags.join(' / ') || '未打标签'}{!c.configured ? '（待配置）' : ''}</option>)}</Select></Field>
        {explicitTag && <div className="info-note">此路由归属标签 {explicitTag}；授权该标签的令牌可调用所选上游。目标渠道的原有路由独立保留。</div>}
        <Field label="上游模型 ID" hint="Cloudflare AI 使用 openai/gpt-4.1 或 @cf/…；自定义服务商使用供应商原始模型 ID。"><Input required disabled={busy} value={upstream} onChange={e => setUpstream(e.target.value)} placeholder="openai/gpt-4.1" /></Field>
      </FormSection>
      <FormSection number="02" title="路由分组与分配">
        <Field label="所属路由组" hint={selectedGroup ? `组内先按路由优先级选择，同优先级采用「${STRATEGY_LABELS[selectedGroup.strategy]}」。移动路由不会改变标签授权。` : missingGroup ? undefined : '默认组的组内分配沿用全局策略。可创建路由组，独立配置组内分配策略。'}><Select value={groupId} onChange={value => { setGroupId(value); setError(''); }} disabled={busy}>{missingGroup && <option value={groupId} disabled>所选路由组已变化，请重新选择</option>}<option value={DEFAULT_GROUP}>默认组 · P0</option>{[...groups].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name)).map(group => <option key={group.id} value={group.id}>{group.name} · P{group.priority}{group.enabled ? '' : '（已停用）'}</option>)}</Select></Field>
        {missingGroup && <ErrorBox message="所选路由组已变化，请重新选择" />}
        <div className="form-columns"><Field label="组内优先级" hint="数值越小越先使用"><Input type="number" required disabled={busy} min={0} max={1000} step={1} value={priority} onChange={e => setPriority(Number(e.target.value))} /></Field><Field label="路由权重" hint="组内采用「按照权重」时，同优先级按此权重分配"><Input type="number" required disabled={busy} min={1} max={1000} step={1} value={weight} onChange={e => setWeight(Number(e.target.value))} /></Field></div>
      </FormSection>
      <div className="info-note">费用由 Cloudflare AI Gateway 统计。自定义模型如需补充单价，请在 Cloudflare 配置 Custom costs。</div>
      <Toggle checked={enabled} onChange={setEnabled} label="启用此路由" disabled={busy} /><ErrorBox message={error} />
      <div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>取消</Button><Button disabled={busy || missingGroup || !channels.length || !modelId.trim()}>{busy ? '保存中…' : '保存路由'}</Button></div>
    </form>
  </Modal>;
}

function GroupForm({ modelId: initialModelId, group, models, onClose, onSaved }: { modelId: string; group: RouteGroup | null; models: Model[]; onClose: () => void; onSaved: (modelId: string) => void }) {
  const [modelId, setModelId] = useState(initialModelId), [name, setName] = useState(group?.name || '');
  const [priority, setPriority] = useState(group?.priority || 0), [weight, setWeight] = useState(group?.weight || 1);
  const [strategy, setStrategy] = useState<RouteGroup['strategy']>(group?.strategy || 'random');
  const [enabled, setEnabled] = useState(group ? !!group.enabled : true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api(`/route-groups${group ? `/${group.id}` : ''}`, { method: group ? 'PUT' : 'POST', body: JSON.stringify({ model_id: modelId.trim(), ...(!group && { create_model: true }), name: name.trim(), priority, weight, strategy, enabled }) });
      refresh(); notify('路由组已保存'); onSaved(modelId.trim()); onClose();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <Modal title={group ? '编辑路由组' : '添加路由组'} description={initialModelId ? `为 ${modelId} 配置组优先级、权重与组内分配方式。` : '输入应用模型 ID 并创建路由组，然后向组内添加上游路由。'} onClose={onClose}>
    <form onSubmit={submit} className="form-stack">
      <FormSection number="01" title="路由组">
        {!initialModelId && <ModelPicker models={models} value={modelId} onChange={setModelId} busy={busy} hint="输入新 ID 可同时创建应用模型；选择已有 ID 则在该模型下添加组。" />}
        <Field label="组名称"><Input required disabled={busy} maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="例如：主力组、备用组" /></Field>
        <div className="form-columns"><Field label="组优先级" hint="数值越小越先使用；P0 优先于 P1"><Input type="number" required disabled={busy} min={0} max={1000} step={1} value={priority} onChange={event => setPriority(Number(event.target.value))} /></Field><Field label="组权重" hint="全局选择「按照权重」时，在同优先级组之间分配"><Input type="number" required disabled={busy} min={1} max={1000} step={1} value={weight} onChange={event => setWeight(Number(event.target.value))} /></Field></div>
      </FormSection>
      <FormSection number="02" title="组内分配" description="选中此组后，先按路由优先级，再按以下策略选择同优先级路由。">
        <Field label="组内分配策略"><Select value={strategy} disabled={busy} onChange={value => setStrategy(value as RouteGroup['strategy'])}><option value="random">随机</option><option value="weighted">按照权重</option><option value="round_robin">轮询</option></Select></Field>
        <div className="info-note">{strategy === 'random' ? '同优先级的路由具有相同的选择概率。' : strategy === 'weighted' ? '同优先级的路由按各自权重分配请求，权重越高，被选中的概率越大。' : '同优先级的路由依次轮流处理请求。'}</div>
      </FormSection>
      <div className="info-note">组设置对该模型的所有标签生效，路由权限仍按标签限制。停用组后，该组内路由不再参与请求分配。</div>
      <Toggle checked={enabled} onChange={setEnabled} label="启用此路由组" disabled={busy} /><ErrorBox message={error} />
      <div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>取消</Button><Button disabled={busy || !modelId.trim() || !name.trim()}>{busy ? '保存中…' : '保存路由组'}</Button></div>
    </form>
  </Modal>;
}

function RouteTable({ routes, channels, label, onEdit, onDelete }: { routes: Route[]; channels: Channel[]; label: string; onEdit: (route: Route) => void; onDelete: (route: Route) => void }) {
  return <div className="route-table-scroll" role="region" aria-label={label} tabIndex={0}><table className="route-table"><colgroup><col className="route-col-model" /><col className="route-col-channel" /><col className="route-col-priority" /><col className="route-col-weight" /><col className="route-col-state" /><col className="route-col-actions" /></colgroup><thead><tr><th scope="col">上游模型</th><th scope="col">渠道 / 协议</th><th scope="col" className="route-numeric">优先级</th><th scope="col" className="route-numeric">权重</th><th scope="col">状态</th><th scope="col" className="route-actions-heading">操作</th></tr></thead><tbody>{[...routes].sort((a, b) => a.priority - b.priority).map(route => {
    const channel = channels.find(channel => channel.id === route.channel_id);
    return <tr key={route.id} className={route.enabled ? '' : 'route-disabled'}><td><code className="route-upstream" title={route.upstream_model}>{route.upstream_model}</code></td><td><span className="route-channel" title={channel?.name || route.channel_id}>{channel?.name || route.channel_id}</span><small className="route-channel-tags">{channel?.tags.join(' / ') || '未打标签'}{route.scope_tag ? ` · 路由归属 ${route.scope_tag}` : ''}</small><span className={`route-protocol${channel ? ` is-${channel.protocol}` : ''}`}>{channel ? PROTOCOL_LABELS[channel.protocol] : '—'}</span></td><td className="route-numeric"><span className="priority-token">P{route.priority}</span></td><td className="route-numeric">{route.weight}</td><td><span className={`route-status ${route.enabled ? 'is-enabled' : ''}`}><i />{route.enabled ? '启用' : '停用'}</span></td><td><div className="route-row-actions"><Button variant="ghost" className="route-edit" aria-label={`编辑路由 ${route.upstream_model}`} onClick={() => onEdit(route)}>编辑</Button><Button variant="ghost" className="icon-btn route-delete" aria-label={`删除路由 ${route.upstream_model}`} onClick={() => onDelete(route)}><Trash2 size={15} /></Button></div></td></tr>;
  })}</tbody></table></div>;
}

export function Models() {
  const models = useApi<Model[]>('/models'), channels = useApi<Channel[]>('/channels');
  const [requestedScopeValue, setScopeValue] = useState('');
  const tags = routeScopeTags(models.data || [], channels.data || []);
  const scopeOptions = [
    ...tags.map(tag => ({ value: `tag:${tag}`, label: tag })),
    ...(channels.data?.some(channel => channel.tags.length === 0) ? [{ value: 'untagged', label: '未打标签' }] : []),
  ];
  const scopeValue = scopeOptions.some(option => option.value === requestedScopeValue) ? requestedScopeValue : scopeOptions[0]?.value;
  const scope: ModelScope | null = !scopeValue ? null : scopeValue === 'untagged' ? { kind: 'untagged' } : { kind: 'tag', tag: scopeValue.slice(4) };
  const scopedChannels = scope ? channels.data?.filter(channel => matchesRouteScope(channel.tags, scope)) || [] : [];
  const scopedModels = scope ? scopeModels(models.data || [], channels.data || [], scope) : [];
  const usedChannelIds = new Set([...scopedChannels.map(channel => channel.id), ...scopedModels.flatMap(model => model.routes.map(route => route.channel_id))]);
  const ready = !!models.data && !!channels.data;
  const canAddRoute = ready && !!scope && (scope.kind === 'tag' ? !!channels.data?.length : !!scopedChannels.length);
  const [search, setSearch] = useState(''), [routeEdit, setRouteEdit] = useState<{ modelId: string; groupId?: string | null; route: Route | null; scope: ModelScope } | null>(null);
  const [groupEdit, setGroupEdit] = useState<{ modelId: string; group: RouteGroup | null } | null>(null);
  const [deleting, setDeleting] = useState<{ path: string; name: string; description: string } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  const [selectedId, setSelectedId] = useState('');
  useEffect(() => {
    if (scopeValue) setScopeValue(scopeValue);
    setSearch('');
  }, [scopeValue]);
  const filtered = scopedModels.filter(m => `${m.id} ${m.description}`.toLowerCase().includes(search.toLowerCase()));
  const selected = filtered.find(model => model.id === selectedId) || filtered[0];
  const visibleGroups: { group: RouteGroup | null; routes: Route[] }[] = selected ? [
    ...((selected.routes.some(route => !route.group_id)) ? [{ group: null, routes: selected.routes.filter(route => !route.group_id) }] : []),
    ...(selected.groups || []).map(group => ({ group, routes: selected.routes.filter(route => route.group_id === group.id) })),
  ].sort((a, b) => (a.group?.priority || 0) - (b.group?.priority || 0) || (a.group?.name || '').localeCompare(b.group?.name || '')) : [];
  function savedModel(modelId: string) { setSelectedId(modelId); setSearch(''); }
  async function remove() {
    setBusy(true); setError('');
    try { await api(deleting!.path, { method: 'DELETE' }); refresh(); setDeleting(null); notify('已删除'); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <div className="models-page">
    <header className="models-page-heading"><div><div className="models-page-title"><h1>模型与路由</h1><span className="models-count">{ready ? scopedModels.length : '—'}</span><span className="models-scope-summary">{ready ? `${usedChannelIds.size} 个渠道 · ${scopedModels.reduce((total, model) => total + model.routes.length, 0)} 条路由` : '—'}</span></div><p>为模型配置路由组，支持添加其他标签的渠道作为上游</p></div><div className="models-page-actions"><Button variant="secondary" disabled={!ready || !scope} onClick={() => setGroupEdit({ modelId: '', group: null })}><Layers3 size={15} />添加路由组</Button><Button disabled={!canAddRoute} onClick={() => scope && setRouteEdit({ modelId: '', route: null, scope })}><Plus size={16} />添加模型路由</Button></div></header>
    {!!scopeOptions.length && <div className="model-scope-bar"><div className="model-scope-options" role="group" aria-label="按服务商标签管理模型路由">{scopeOptions.map(option => <Button key={option.value} type="button" variant="ghost" className="model-scope-tag" aria-pressed={scopeValue === option.value} onClick={() => { if (scopeValue !== option.value) { setScopeValue(option.value); setSearch(''); } }}>{option.label}</Button>)}</div></div>}
    <ErrorBox message={models.error || channels.error} />
    <div className="model-workspace surface">
      <aside className="model-directory"><div className="directory-heading"><h2>模型目录</h2><span>{search ? `${filtered.length} / ` : ''}{ready ? scopedModels.length : '—'}</span></div><div className="search-field"><Search size={16} /><Input aria-label="搜索模型" placeholder="搜索模型或描述" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <div className="model-options" role="group" aria-label="选择模型">{filtered.map(model => <button type="button" className={`model-option ${selected?.id === model.id ? 'selected' : ''}`} key={model.id} onClick={() => setSelectedId(model.id)} aria-pressed={selected?.id === model.id}><span className="model-option-copy"><strong title={model.id}>{model.id}</strong><small><i className={model.enabled ? 'is-enabled' : ''} />{model.routes.length} 条路由 · {model.enabled ? '已启用' : '已停用'}</small></span><ChevronRight size={14} /></button>)}</div>
        <div className="directory-foot"><GitBranch size={15} />组优先级 → 组内路由分配</div>
      </aside>
      <section className="routing-workspace">{(models.loading && !models.data) || (channels.loading && !channels.data) ? <Loading /> : selected && scope ? <>
        <header className="routing-heading"><div className="routing-model-copy"><div className="routing-model-title"><h2>{selected.id}</h2><Badge tone={selected.enabled ? 'green' : 'neutral'}>{selected.enabled ? '已启用' : '全局停用'}</Badge></div>{selected.description && <p>{selected.description}</p>}</div></header>
        <div className="routing-toolbar"><div><h3>路由分组</h3><span>{visibleGroups.length} 组 · {selected.routes.length} 条路由</span></div><div className="routing-toolbar-actions"><Button variant="secondary" onClick={() => setGroupEdit({ modelId: selected.id, group: null })}><Layers3 size={15} />添加组</Button><Button variant="secondary" disabled={!canAddRoute} onClick={() => setRouteEdit({ modelId: selected.id, route: null, scope })}><Plus size={15} />添加路由</Button></div></div>
        <p className="routing-group-guide">先按组优先级与全局分配策略选组，再按组内优先级与策略选择路由。</p>
        {visibleGroups.length ? <div className="route-groups" key={selected.id}>{visibleGroups.map(({ group, routes }) => {
          const name = group?.name || '默认组';
          const allRouteCount = group ? (group.route_count ?? models.data?.find(model => model.id === selected.id)?.routes.filter(route => route.group_id === group.id).length ?? 0) : 0;
          return <section className={`route-group${group && !group.enabled ? ' route-group-disabled' : ''}`} key={group?.id || DEFAULT_GROUP} aria-label={`路由组 ${name}`}>
            <header className="route-group-heading"><div className="route-group-copy"><div className="route-group-title"><Layers3 size={15} /><h4>{name}</h4><span className="priority-token">P{group?.priority || 0}</span>{group && !group.enabled && <Badge>已停用</Badge>}</div><div className="route-group-meta"><span>组权重 {group?.weight || 1}</span><span>组内：{group ? STRATEGY_LABELS[group.strategy] : '沿用全局策略'}</span><span>{routes.length} 条路由</span></div></div>
              <div className="route-group-actions">{group && <><Button variant="ghost" aria-label={`编辑路由组 ${name}`} onClick={() => setGroupEdit({ modelId: selected.id, group })}>编辑组</Button><span title={allRouteCount ? '请先移出或删除组内所有标签的路由，再删除此组' : '删除空路由组'}><Button variant="ghost" className="icon-btn route-delete" disabled={allRouteCount > 0} aria-label={`删除路由组 ${name}`} onClick={() => { setError(''); setDeleting({ path: `/route-groups/${group.id}`, name, description: '删除此空路由组。组设置对该模型的所有标签生效。' }); }}><Trash2 size={15} /></Button></span></>}<Button variant="secondary" disabled={!canAddRoute} aria-label={`向 ${name} 添加路由`} onClick={() => setRouteEdit({ modelId: selected.id, groupId: group?.id || null, route: null, scope })}><Plus size={14} />添加路由</Button></div>
            </header>
            {routes.length ? <RouteTable routes={routes} channels={channels.data || []} label={`${selected.id} · ${name} 的上游路由`} onEdit={route => setRouteEdit({ modelId: selected.id, route, scope })} onDelete={route => { setError(''); setDeleting({ path: `/routes/${route.id}${routeScopeQuery(scope)}`, name: route.upstream_model, description: '后续请求不再使用此路由。' }); }} /> : <p className="route-group-empty">组内暂无路由。添加上游路由后，此组即可参与请求分配。</p>}
            {!group && <p className="route-group-default-note">未分组路由保留原有分配方式。编辑路由可将其移入其他组。</p>}
          </section>;
        })}</div> : <Empty title="为模型添加一条路径" description="创建路由组并添加上游，或直接添加默认组路由。" action={<Button variant="secondary" disabled={!canAddRoute} onClick={() => setRouteEdit({ modelId: selected.id, route: null, scope })}><Plus size={16} />添加路由</Button>} />}
        <div className="routing-explainer"><GitBranch size={14} /><p>组设置对该模型的所有标签生效，此处仅展示当前标签可管理的路由。API Key 可使用授权标签的渠道路由，以及明确加入该标签的跨标签路由。</p></div>
      </> : <Empty title={search ? '没有匹配的模型' : scope ? '当前标签下还没有模型路由' : '请先添加渠道'} description={search ? '试试其他模型 ID 或描述。' : scope ? '输入新模型 ID 或选择已有模型，创建路由组或添加上游路由。' : '在渠道管理中添加渠道并设置标签，然后管理对应的模型路由。'} action={!search && (canAddRoute ? <Button variant="secondary" onClick={() => scope && setRouteEdit({ modelId: '', route: null, scope })}><Plus size={16} />添加模型路由</Button> : <Button variant="secondary" onClick={() => { window.location.hash = 'channels'; }}>前往渠道管理</Button>)} />}</section>
    </div>
    {routeEdit && <RouteForm {...routeEdit} models={models.data || []} channels={(channels.data || []).filter(channel => routeEdit.scope.kind === 'tag' || matchesRouteScope(channel.tags, routeEdit.scope)).sort((a, b) => Number(matchesRouteScope(b.tags, routeEdit.scope)) - Number(matchesRouteScope(a.tags, routeEdit.scope)))} onSaved={savedModel} onClose={() => setRouteEdit(null)} />}
    {groupEdit && <GroupForm {...groupEdit} models={models.data || []} onSaved={savedModel} onClose={() => setGroupEdit(null)} />}
    {deleting && <Confirm title={`删除 ${deleting.name}？`} description={deleting.description} onConfirm={remove} onClose={() => setDeleting(null)} busy={busy} error={error} />}
  </div>;
}
