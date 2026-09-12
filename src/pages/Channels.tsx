import '../channels.css';
import { MAX_CHANNEL_TIMEOUT_SECONDS } from '../../shared/channel-limits';
import { PROTOCOL_FULL_LABELS, PROTOCOL_LABELS, PROTOCOL_PATHS } from '../../shared/protocols';
import { useContext, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronLeft, ChevronRight, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import type { Channel, CustomProvider, ProviderPage, ProviderProfile } from '../types';
import { api, channelLabel, RefreshContext, ToastContext, useApi } from '../lib';
import { ProviderFields, type ProviderFieldsHandle } from '../ProviderFields';
import { ChannelAvailability } from '../ChannelAvailability';
import type { ChannelAvailability as ChannelAvailabilityReport, ChannelAvailabilityResponse } from '../../shared/observability';
import { Badge, Button, Confirm, Empty, ErrorBox, Field, Loading, Modal, PageTitle, Toggle, Input, Select, FormSection } from '../components';

function ProviderPicker({ selected, onSelect }: { selected: string; onSelect: (provider: CustomProvider) => void }) {
  const [page, setPage] = useState(1), [input, setInput] = useState(''), [search, setSearch] = useState('');
  const providers = useApi<ProviderPage>(`/providers?page=${page}&search=${encodeURIComponent(search)}`);
  return <div className="form-stack"><div className="flex gap-2"><Input aria-label="搜索 Cloudflare 服务商" placeholder="按名称或 slug 搜索" value={input} onChange={e => setInput(e.target.value)} /><Button type="button" variant="secondary" onClick={() => { setSearch(input); setPage(1); }}><Search size={15} />搜索</Button></div><ErrorBox message={providers.error} /><Field label="Cloudflare 服务商"><Select value={selected} required onChange={value => { const provider = providers.data?.data.find(p => p.id === value); if (provider) onSelect(provider); }}><option value="">请选择</option>{selected && !providers.data?.data.some(p => p.id === selected) && <option value={selected}>{selected}</option>}{providers.data?.data.map(p => <option value={p.id} key={p.id}>{p.name} · {p.slug}{p.enable === false ? '（已停用）' : ''}</option>)}</Select></Field><div className="flex justify-between items-center"><Button type="button" variant="ghost" disabled={page === 1 || providers.loading} onClick={() => setPage(p => p - 1)}>上一页</Button><span className="muted">第 {page} 页</span><Button type="button" variant="ghost" disabled={!providers.data?.has_more || providers.loading} onClick={() => setPage(p => p + 1)}>下一页</Button></div></div>;
}
function ChannelForm({ channel, onClose }: { channel: Channel | null; onClose: () => void }) {
  const providerFields = useRef<ProviderFieldsHandle>(null);
  const [name, setName] = useState(channel?.name || ''), [kind, setKind] = useState<Channel['kind']>(channel?.kind || 'openai');
  const [profile, setProfile] = useState<ProviderProfile>({ protocol: channel?.protocol || 'openai', tags: channel?.tags || [], models: channel?.models || [] });
  const [mode, setMode] = useState(channel?.provider_id ? 'existing' : 'new');
  const [autoCreateRoutes, setAutoCreateRoutes] = useState(!!(channel?.auto_create_routes ?? 1));
  const [profileDirty, setProfileDirty] = useState(false), [fetching, setFetching] = useState(false), [discoverySecret, setDiscoverySecret] = useState('');
  const [providerId, setProviderId] = useState(channel?.provider_id || ''), [slug, setSlug] = useState(channel?.provider_slug || '');
  const [url, setUrl] = useState(channel?.base_url || ''), [path, setPath] = useState(channel?.gateway_path || 'v1/chat/completions');
  const [alias, setAlias] = useState(channel?.byok_alias || ''), [secret, setSecret] = useState('');
  const [credentialMode, setCredentialMode] = useState(channel?.kind === 'openai' && channel.byok_alias && !channel.has_secret ? 'byok' : 'local');
  const [timeout, setTimeoutValue] = useState((channel?.timeout_ms || 60000) / 1000), [enabled, setEnabled] = useState(channel ? !!channel.enabled : true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  async function submit(e: FormEvent) {
    e.preventDefault(); if (fetching) return;
    const committed = providerFields.current?.commitModels();
    if (committed === null) return;
    const submittedProfile = kind === 'openai' ? committed ?? profile : { protocol: 'openai' as const, tags: [], models: [] };
    setBusy(true); setError('');
    try {
      await api(`/channels${channel ? `/${channel.id}` : ''}`, { method: channel ? 'PUT' : 'POST', body: JSON.stringify({ ...submittedProfile, auto_create_routes: autoCreateRoutes, update_profile: profileDirty || submittedProfile !== profile, name, kind, base_url: url, secret: kind !== 'openai' || credentialMode === 'local' ? secret || undefined : undefined, credential_mode: kind === 'openai' ? credentialMode : undefined, timeout_ms: timeout * 1000, enabled, provider_id: mode === 'existing' ? providerId : undefined, provider_slug: slug || undefined, gateway_path: path, byok_alias: kind === 'openai' && credentialMode === 'byok' ? alias : '' }) });
      refresh(); notify(channel ? '渠道已更新' : '渠道已接入 AI Gateway'); onClose();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <Modal title={channel ? '编辑渠道' : '添加 AI Gateway 渠道'} description="在此配置上游连接、凭据和模型，推理请求经过 Cloudflare AI Gateway。" onClose={onClose}><form onSubmit={submit} className="form-stack">
    <FormSection number="01" title="渠道标识"><Field label="渠道名称"><Input required maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="例如：我的模型服务" autoFocus /></Field>
    <Field label="接入方式"><Select value={kind} onChange={value => { setKind(value as Channel['kind']); setSecret(''); setFetching(false); }}>{Object.entries(channelLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
    </FormSection><FormSection number="02" title="上游连接">{kind === 'openai' ? <>
      {!channel?.provider_id && <Field label="服务商来源"><Select value={mode} onChange={value => { setMode(value); setProviderId(''); setProfileDirty(false); setFetching(false); }}><option value="new">在 Cloudflare 创建新服务商</option><option value="existing">关联已有 Cloudflare 服务商</option></Select></Field>}
      {mode === 'existing' ? <><ProviderPicker selected={providerId} onSelect={provider => { setProviderId(provider.id); setSlug(provider.slug); setUrl(provider.base_url); setProfile({ protocol: provider.protocol, tags: provider.tags, models: provider.models }); setProfileDirty(false); setAlias(''); setSecret(''); setDiscoverySecret(''); setPath(`${new URL(provider.base_url).pathname.replace(/\/+$/, '').endsWith('/v1') ? '' : 'v1/'}${PROTOCOL_PATHS[provider.protocol]}`); }} /><div className="info-note">服务商地址：{url || '选择服务商后显示'}</div></> : <><Field label="服务商 Slug" hint="在 Cloudflare 账户内唯一，小写字母、数字和短横线；无需添加 custom- 前缀。"><Input required value={slug} pattern="[a-z0-9]+(-[a-z0-9]+)*" onChange={e => setSlug(e.target.value)} placeholder="my-provider" /></Field><Field label="服务商 Base URL" hint="填写根域名或固定路径前缀，下面的请求路径会原样追加。"><Input type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://api.example.com" /></Field></>}
      <Field label="推理请求路径" hint="Chat Completions 使用 v1/chat/completions，Responses 使用 v1/responses，Anthropic 使用 v1/messages；Base URL 已包含 /v1 时省略该前缀。"><Input required value={path} onChange={e => setPath(e.target.value)} placeholder={`v1/${PROTOCOL_PATHS[profile.protocol]}`} /></Field>
      <Field label="凭据保存方式"><Select value={credentialMode} onChange={value => { setCredentialMode(value); setSecret(''); }}><option value="local">程序加密存储（推荐）</option><option value="byok">使用已有 Cloudflare BYOK 别名</option></Select></Field>
      {credentialMode === 'local' ? <Field label="供应商 API Key" hint="加密保存在本程序数据库，调用时由 AI Gateway 转发给供应商，无需 Secrets Store。编辑时留空保留原密钥；更换服务商或请求地址需重新填写。"><Input type="password" autoComplete="new-password" required={!(channel?.kind === 'openai' && channel.has_secret)} value={secret} onChange={e => setSecret(e.target.value)} placeholder={channel?.kind === 'openai' && channel.has_secret ? '已加密保存，留空保持不变' : '输入供应商 API Key'} /></Field>
        : <Field label="已有 BYOK 别名" hint="填写此服务商在当前 AI Gateway 中已配置的别名。程序不会上传或修改 Cloudflare 的密钥。"><Input value={alias} onChange={e => setAlias(e.target.value)} placeholder="例如 default" required /></Field>}
      {credentialMode === 'byok' && <Field label="获取模型用 API Key" hint="BYOK 别名无法读取密钥。此处的 Key 仅用于获取模型，不会保存。"><Input type="password" autoComplete="new-password" value={discoverySecret} onChange={e => setDiscoverySecret(e.target.value)} placeholder="需要自动获取模型时填写" /></Field>}
      <ProviderFields ref={providerFields} key={`${kind}:${mode}:${providerId}`} routeCreation={{ enabled: autoCreateRoutes, onChange: setAutoCreateRoutes }} value={profile} readOnly={busy} discovery={{ base_url: url, secret: (credentialMode === 'local' ? secret : discoverySecret) || undefined, channel_id: credentialMode === 'local' && channel?.has_secret ? channel.id : undefined, provider_id: providerId || undefined }} onLoadingChange={setFetching} onChange={value => { if (value.protocol !== profile.protocol) setPath(previous => previous === PROTOCOL_PATHS[profile.protocol] ? PROTOCOL_PATHS[value.protocol] : previous === `v1/${PROTOCOL_PATHS[profile.protocol]}` ? `v1/${PROTOCOL_PATHS[value.protocol]}` : previous); setProfile(value); setProfileDirty(true); }} />
      {mode === 'existing' && <div className="info-note">协议、标签和模型清单由此服务商的关联渠道共享；保存修改会同步到本工作空间内的所有关联渠道。</div>}
      {channel?.has_secret && !channel.provider_id && <div className="info-note">此渠道来自旧版直连配置。关联到相同上游地址后可继续使用已加密的密钥，推理会经过 AI Gateway。</div>}
    </> : <><div className="info-note">{kind === 'cloudflare' ? '使用 Cloudflare AI REST API 与统一计费。' : '调用 AI Gateway 的内置模型或 dynamic/ 动态路由；供应商凭据在 Cloudflare BYOK 配置。'} Account ID 和 Gateway ID 在 Worker 环境变量中配置。</div><Field label="Cloudflare Token（可选覆盖）" hint={`留空使用 ${kind === 'cloudflare' ? 'CF_AI_TOKEN' : 'CF_AIG_TOKEN / CF_API_TOKEN'}。`}><Input type="password" autoComplete="new-password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={channel?.has_secret ? '已保存，留空保持不变' : '使用 Worker Secret'} /></Field></>}
    </FormSection><FormSection number="03" title="运行策略"><Field label="单次请求总超时（秒）" hint={`从发起上游请求到完整响应结束，包含 SSE 全程，不是首字超时。1–${MAX_CHANNEL_TIMEOUT_SECONDS} 秒；20 分钟填 1200。每次重试独立计时。`}><Input type="number" min={1} max={MAX_CHANNEL_TIMEOUT_SECONDS} step={1} required value={timeout} onChange={e => setTimeoutValue(Number(e.target.value))} /></Field><Toggle checked={enabled} onChange={setEnabled} label="启用渠道" /></FormSection>
    <ErrorBox message={error} /><div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>取消</Button><Button disabled={busy || fetching}>{busy ? '正在配置 Cloudflare…' : '保存渠道'}</Button></div></form></Modal>;
}
function ProviderForm({ provider, channels, onClose }: { provider: CustomProvider | null; channels: Channel[]; onClose: () => void }) {
  const providerFields = useRef<ProviderFieldsHandle>(null);
  const savedChannels = channels.filter(channel => channel.provider_id === provider?.id && channel.has_secret);
  const [credentialChannel, setCredentialChannel] = useState(savedChannels[0]?.id || ''), [secret, setSecret] = useState(''), [fetching, setFetching] = useState(false);
  const [profile, setProfile] = useState<ProviderProfile>({ protocol: provider?.protocol || 'openai', tags: provider?.tags || [], models: provider?.models || [] });
  const [name, setName] = useState(provider?.name || ''), [slug, setSlug] = useState(provider?.slug || ''), [url, setUrl] = useState(provider?.base_url || ''), [description, setDescription] = useState(provider?.description || ''), [enable, setEnable] = useState(provider?.enable !== false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  async function submit(e: FormEvent) {
    e.preventDefault(); if (fetching) return;
    const committed = providerFields.current?.commitModels();
    if (committed === null) return;
    setBusy(true); setError('');
    try { await api(`/providers${provider ? `/${provider.id}` : ''}`, { method: provider ? 'PATCH' : 'POST', body: JSON.stringify({ ...(committed ?? profile), name, slug, base_url: url, description, enable }) }); refresh(); notify('Cloudflare 服务商已保存'); onClose(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <Modal title={provider ? '编辑 Cloudflare 服务商' : '创建 Cloudflare 服务商'} description="这是账户级资源，同一账户的其他 AI Gateway 也会使用此配置。" onClose={onClose}><form onSubmit={submit} className="form-stack"><FormSection number="01" title="服务商标识"><Field label="名称"><Input required value={name} onChange={e => setName(e.target.value)} /></Field><Field label="Slug"><Input required disabled={!!provider} value={slug} onChange={e => setSlug(e.target.value)} pattern="[a-z0-9]+(-[a-z0-9]+)*" /></Field><Field label="Base URL" hint={provider ? '切换服务地址请新建服务商，避免影响已绑定的凭据。' : '填写 HTTPS 根域名或固定路径前缀。'}><Input type="url" required disabled={!!provider} value={url} onChange={e => setUrl(e.target.value)} /></Field></FormSection><FormSection number="02" title="协议与资源">{savedChannels.length > 0 && <Field label="获取模型使用的渠道密钥"><Select value={credentialChannel} onChange={setCredentialChannel}>{savedChannels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</Select></Field>}<Field label="获取模型用 API Key" hint={savedChannels.length ? '留空使用所选渠道已保存的密钥；填写新 Key 仅用于本次获取，不会替换渠道密钥。' : '仅用于从上游获取模型，不会保存在服务商配置中。'}><Input type="password" autoComplete="new-password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={savedChannels.length ? '使用渠道已保存的密钥' : '输入供应商 API Key'} /></Field><ProviderFields ref={providerFields} value={profile} onChange={setProfile} readOnly={busy} discovery={{ base_url: url, secret: secret || undefined, channel_id: credentialChannel || undefined, provider_id: provider?.id }} onLoadingChange={setFetching} /></FormSection><FormSection number="03" title="状态与备注"><Field label="描述"><Input value={description} onChange={e => setDescription(e.target.value)} maxLength={500} /></Field><Toggle label="在 Cloudflare 启用此服务商" checked={enable} onChange={setEnable} /></FormSection><ErrorBox message={error} /><div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button disabled={busy || fetching}>{busy ? '保存中…' : '保存到 Cloudflare'}</Button></div></form></Modal>;
}
function Providers({ channels }: { channels: Channel[] }) {
  const [page, setPage] = useState(1), [editing, setEditing] = useState<CustomProvider | null | undefined>(), [deleting, setDeleting] = useState<CustomProvider | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const providers = useApi<ProviderPage>(`/providers?page=${page}`), { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  async function remove() { setBusy(true); setError(''); try { await api(`/providers/${deleting!.id}`, { method: 'DELETE' }); refresh(); setDeleting(null); notify('Cloudflare 服务商已删除'); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }
  return <><div className="section-toolbar"><div className="resource-counters"><span><strong>{providers.data?.total ?? '—'}</strong>账户服务商</span></div><Button onClick={() => setEditing(null)}><Plus size={16} />创建服务商</Button></div><ErrorBox message={providers.error} />
    {providers.loading ? <Loading /> : providers.data?.data.length ? <div className="provider-grid">{providers.data.data.map(provider => <article className="surface cloud-provider-card" key={provider.id}>
      <header><div><h2>{provider.name}</h2><code>custom-{provider.slug}</code></div><Badge tone={provider.enable === false ? 'neutral' : 'green'}>{provider.enable === false ? '已停用' : '已启用'}</Badge></header>
      <div className="provider-address"><span className="mini-label">BASE URL</span><code>{provider.base_url}</code></div>
      <div className="provider-profile"><div><span className="mini-label">协议</span><strong>{PROTOCOL_FULL_LABELS[provider.protocol]}</strong></div><div><span className="mini-label">模型清单</span><strong>{provider.models.length} 个模型</strong></div></div>
      <div className="tag-list">{provider.tags.length ? provider.tags.map(tag => <Badge key={tag}>{tag}</Badge>) : <span className="muted">未设置标签</span>}</div>
      <footer><span className="surface-caption">CLOUDFLARE RESOURCE</span><div className="row-actions"><Button variant="secondary" aria-label={`编辑服务商 ${provider.name}`} onClick={() => setEditing(provider)}><Pencil size={15} />编辑</Button><Button variant="ghost" className="icon-btn danger-text" aria-label={`删除服务商 ${provider.name}`} onClick={() => { setDeleting(provider); setError(''); }}><Trash2 size={16} /></Button></div></footer>
    </article>)}</div> : !providers.error && <section className="surface"><Empty title="Cloudflare 暂无自定义服务商" description="创建服务商后即可在本地渠道中关联。" action={<Button variant="secondary" onClick={() => setEditing(null)}><Plus size={16} />创建服务商</Button>} /></section>}
    <div className="pagination provider-pagination"><span>第 {page} 页 · {providers.data?.total ?? '—'} 个服务商</span><div><Button variant="secondary" disabled={page === 1 || providers.loading} onClick={() => setPage(p => p - 1)}>上一页</Button><Button variant="secondary" disabled={!providers.data?.has_more || providers.loading} onClick={() => setPage(p => p + 1)}>下一页</Button></div></div>
    {editing !== undefined && <ProviderForm provider={editing} channels={channels} onClose={() => setEditing(undefined)} />}{deleting && <Confirm title={`从 Cloudflare 删除 ${deleting.name}？`} description="这会删除账户级服务商，其他应用或 Gateway 使用它的请求也会中断。本程序无法检测其他应用的依赖，请确认已停止使用。" onConfirm={remove} onClose={() => setDeleting(null)} busy={busy} error={error} />}</>;

}
type ChannelView = 'all' | 'openai' | 'anthropic' | 'responses' | 'configured' | 'pending' | 'disabled';
const channelState = (channel: Channel) => !channel.enabled ? 'disabled' : channel.configured ? 'configured' : 'pending';
const viewLabels: Record<ChannelView, string> = { all: '全部渠道', ...PROTOCOL_LABELS, configured: '已配置', pending: '待配置', disabled: '已停用' };
function ChannelEntry({ channel, availability, availabilityData, availabilityLoading, availabilityError, onEdit, onDelete }: {
  channel: Channel; availability?: ChannelAvailabilityReport; availabilityData: ChannelAvailabilityResponse | null;
  availabilityLoading: boolean; availabilityError: string; onEdit: (channel: Channel) => void; onDelete: () => void;
}) {
  const [enabled, setEnabled] = useState(!!channel.enabled), [saving, setSaving] = useState(false), [toggleError, setToggleError] = useState('');
  const savingRef = useRef(false);
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  useEffect(() => { if (!savingRef.current) setEnabled(!!channel.enabled); }, [channel.enabled]);
  async function toggle(value: boolean) {
    if (savingRef.current) return;
    savingRef.current = true;
    const previous = enabled;
    setEnabled(value); setSaving(true); setToggleError('');
    try {
      const saved = await api<{ enabled: boolean }>(`/channels/${channel.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: value }) });
      setEnabled(saved.enabled);
      refresh(); notify(`${channel.name} 已${value ? '启用' : '停用'}`);
    } catch (err) { setEnabled(previous); setToggleError((err as Error).message); }
    finally { savingRef.current = false; setSaving(false); }
  }
  return <article className={`channel-entry${enabled ? '' : ' is-disabled'}`}>
    <header className="channel-entry-heading">
      <div className="channel-entry-title">
        {!!channel.tags.length && <div className="entry-tags" aria-label="渠道标签">
          {channel.tags.slice(0, 1).map(tag => <span key={tag} title={tag}>{tag}</span>)}
          {channel.tags.length > 1 && <span title={channel.tags.slice(1).join('、')} aria-label={`其他标签：${channel.tags.slice(1).join('、')}`}>+{channel.tags.length - 1}</span>}
        </div>}
        <h3 title={channel.name}>{channel.name}</h3>
      </div>
      <span className={`entry-protocol is-${channel.protocol}`}>{PROTOCOL_LABELS[channel.protocol]}</span>
    </header>
    <div className="channel-entry-body">
      <ChannelAvailability report={availability} data={availabilityData} loading={availabilityLoading} error={availabilityError} />
      <ErrorBox message={toggleError} />
    </div>
    <footer className="channel-entry-footer">
      <div className="entry-toggle" aria-busy={saving}><Toggle checked={enabled} onChange={toggle} disabled={saving} aria-label={`启用渠道 ${channel.name}`} label={saving ? '保存中…' : enabled ? '已启用' : '已停用'} /></div>
      <div className="channel-entry-operations">
        <Button type="button" variant="ghost" className="entry-edit" disabled={saving} aria-label={`编辑渠道 ${channel.name}`} onClick={() => onEdit({ ...channel, enabled: +enabled })}>编辑</Button>
        <Button type="button" variant="ghost" className="entry-delete" disabled={saving} aria-label={`删除渠道 ${channel.name}`} onClick={onDelete}>删除</Button>
      </div>
    </footer>
  </article>;
}
export function Channels() {
  const { data, error, loading } = useApi<Channel[]>('/channels');
  const availability = useApi<ChannelAvailabilityResponse>('/channels/availability');
  const availabilityByChannel = new Map(availability.data?.data.map(report => [report.channel_id, report]));
  const [showProviders, setShowProviders] = useState(false), [editing, setEditing] = useState<Channel | null | undefined>(), [deleting, setDeleting] = useState<Channel | null>(null);
  const [busy, setBusy] = useState(false), [deleteError, setDeleteError] = useState('');
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  async function remove() { setBusy(true); setDeleteError(''); try { await api(`/channels/${deleting!.id}`, { method: 'DELETE' }); setDeleting(null); refresh(); notify('本地渠道已删除，Cloudflare 服务商保留'); } catch (err) { setDeleteError((err as Error).message); } finally { setBusy(false); } }
  const [search, setSearch] = useState(''), [view, setView] = useState<ChannelView>('all');
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(20);
  const directoryScroll = useRef<HTMLDivElement>(null);
  const filtered = data?.filter(channel => `${channel.name} ${channel.provider_slug || ''} ${channel.base_url} ${channel.tags.join(' ')}`.toLowerCase().includes(search.trim().toLowerCase()) && (view === 'all' || channel.protocol === view || channelState(channel) === view));
  const totalPages = Math.max(1, Math.ceil((filtered?.length || 0) / pageSize));
  const currentPage = Math.min(page, totalPages), offset = (currentPage - 1) * pageSize;
  const visibleChannels = filtered?.slice(offset, offset + pageSize);
  useEffect(() => { setPage(previous => Math.min(previous, totalPages)); }, [totalPages]);
  useEffect(() => { if (directoryScroll.current) directoryScroll.current.scrollTop = 0; }, [currentPage, pageSize, search, view]);
  if (showProviders) return <>
    <PageTitle title="Cloudflare 账户资源" description="管理账户级服务商的名称、状态和生命周期。日常连接与模型配置可在渠道中完成。" action={<Button variant="secondary" onClick={() => setShowProviders(false)}><ArrowLeft size={16} />返回渠道管理</Button>} />
    <Providers channels={data || []} />
  </>;
  const configuredCount = data?.filter(channel => channel.enabled && channel.configured).length;
  const modelCount = data ? new Set(data.flatMap(channel => channel.models)).size : undefined;
  const hasFilters = !!search || view !== 'all';
  const counts: Record<ChannelView, number | undefined> = { all: data?.length, openai: data?.filter(channel => channel.protocol === 'openai').length, anthropic: data?.filter(channel => channel.protocol === 'anthropic').length, responses: data?.filter(channel => channel.protocol === 'responses').length, configured: configuredCount, pending: data?.filter(channel => channelState(channel) === 'pending').length, disabled: data?.filter(channel => !channel.enabled).length };
  function clearFilters() { setSearch(''); setView('all'); setPage(1); }
  function chooseView(next: ChannelView) { setView(next); setPage(1); }
  return <>
    <div className="channels-page">
      <header className="channels-heading">
        <div className="channels-heading-copy"><div className="channels-title"><h1>渠道管理</h1><span className="channels-total">{data?.length ?? '—'}</span></div><div className="channels-overview"><span>{configuredCount ?? '—'} 个已配置</span><span>{modelCount ?? '—'} 个服务商模型</span></div></div>
        <div className="channels-heading-actions"><Button variant="secondary" onClick={() => setShowProviders(true)}>Cloudflare 账户资源</Button><Button onClick={() => setEditing(null)}><Plus size={16} strokeWidth={1.5} />添加渠道</Button></div>
      </header>

      <div className="channels-workspace">
        <aside className="channels-sidebar" aria-label="渠道分类">
          <nav className="channels-category-group" aria-label="按协议筛选"><h2>渠道分类</h2>{(['all', 'openai', 'responses', 'anthropic'] as const).map(category => <button type="button" className={`channels-category ${view === category ? 'is-selected' : ''}`} data-category={category} aria-pressed={view === category} key={category} onClick={() => chooseView(category)}><span>{viewLabels[category]}</span><span>{counts[category] ?? '—'}</span></button>)}</nav>
          <nav className="channels-category-group" aria-label="按配置状态筛选"><h2>配置状态</h2>{(['configured', 'pending', 'disabled'] as const).map(category => <button type="button" className={`channels-category ${view === category ? 'is-selected' : ''}`} data-category={category} aria-pressed={view === category} key={category} onClick={() => chooseView(category)}><span>{viewLabels[category]}</span><span>{counts[category] ?? '—'}</span></button>)}</nav>
          <div className="channels-sidebar-note"><span>Cloudflare AI Gateway</span><p>统一转发 · 日志 · 缓存</p><a href="https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/" target="_blank" rel="noreferrer">接入文档<ArrowUpRight size={14} /></a></div>
        </aside>
        <section className="channels-directory" aria-label="渠道列表">
          <div className="channels-toolbar"><div className="channels-section-title"><h2>{viewLabels[view]}</h2><span>{filtered?.length ?? '—'}</span></div><div className="channels-search"><Search size={17} /><Input aria-label="搜索渠道" placeholder="搜索名称、地址或标签" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />{search && <Button type="button" variant="ghost" className="icon-btn" aria-label="清除搜索" onClick={() => { setSearch(''); setPage(1); }}><X size={14} /></Button>}</div></div>
          <ErrorBox message={error} /><ErrorBox message={availability.error ? `渠道可用率读取失败：${availability.error}` : ''} onRetry={availability.reload} />
          {loading && !data ? <Loading /> : error && !data ? null : !visibleChannels?.length ? <Empty title={hasFilters ? '没有找到匹配的渠道' : '添加第一个渠道'} description={hasFilters ? '试试其他关键词，或清除当前筛选。' : '接入服务商后，在这里统一管理模型与连接。'} action={hasFilters ? <Button variant="secondary" onClick={clearFilters}>清除筛选</Button> : <Button onClick={() => setEditing(null)}><Plus size={17} />添加渠道</Button>} /> : <>
            <div ref={directoryScroll} className="channels-entries" role="region" aria-label="供应商渠道" tabIndex={0}>{visibleChannels.map(channel => <ChannelEntry key={channel.id} channel={channel} availability={availabilityByChannel.get(channel.id)} availabilityData={availability.data} availabilityLoading={availability.loading} availabilityError={availability.error} onEdit={setEditing} onDelete={() => { setDeleting(channel); setDeleteError(''); }} />)}</div>
          <footer className="channels-pagination">
            <span className="channels-range">第 {offset + 1}–{Math.min(offset + pageSize, filtered?.length || 0)} 条，共 {filtered?.length || 0} 条</span>
            <div className="channels-pagination-controls"><Select aria-label="每页渠道数量" value={String(pageSize)} onChange={value => { setPageSize(Number(value)); setPage(1); }}><option value="20">20 条 / 页</option><option value="50">50 条 / 页</option><option value="100">100 条 / 页</option></Select><div className="channels-page-buttons"><Button variant="ghost" className="icon-btn" aria-label="上一页渠道" disabled={currentPage === 1 || loading} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={17} /></Button><span aria-live="polite">{currentPage} <span>/ {totalPages}</span></span><Button variant="ghost" className="icon-btn" aria-label="下一页渠道" disabled={currentPage === totalPages || loading} onClick={() => setPage(currentPage + 1)}><ChevronRight size={17} /></Button></div></div>
          </footer>
          </>}
        </section>
      </div>
      <footer className="channels-footnote"><p>{!availability.loading && !availability.error && availability.data?.coverage === 'partial' && <><strong>本次可用率样本不完整。</strong>{availability.data.warning} </>}可用率按本次从 Cloudflare 读取的非缓存请求样本统计，非实时探测。每块 2 分钟，灰色表示样本中无有效记录；样本不完整时会标明，悬停查看原因和读取时间。</p><a className="text-link" href="https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/" target="_blank" rel="noreferrer">AI Gateway 接入文档<ArrowUpRight size={14} /></a></footer>
    </div>
    {editing !== undefined && <ChannelForm channel={editing} onClose={() => setEditing(undefined)} />}
    {deleting && <Confirm title={`删除本地渠道 ${deleting.name}？`} description="此渠道、加密保存的密钥及其模型路由会被移除。Cloudflare 的服务商、已有 BYOK 密钥与日志会保留。" onConfirm={remove} onClose={() => setDeleting(null)} busy={busy} error={deleteError} />}
  </>;
}
