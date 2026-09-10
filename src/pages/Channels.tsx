import { Tabs } from '@heroui/react';
import { useContext, useState, type FormEvent } from 'react';
import { ArrowUpRight, Cloud, Radio, Layers, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import type { Channel, CustomProvider, ProviderPage, ProviderProfile } from '../types';
import { api, channelLabel, RefreshContext, ToastContext, useApi } from '../lib';
import { ProviderFields } from '../ProviderFields';
import { Badge, Button, Confirm, Empty, ErrorBox, Field, Loading, Modal, PageTitle, Toggle, Input, Select, FormSection } from '../components';

function ProviderPicker({ selected, onSelect }: { selected: string; onSelect: (provider: CustomProvider) => void }) {
  const [page, setPage] = useState(1), [input, setInput] = useState(''), [search, setSearch] = useState('');
  const providers = useApi<ProviderPage>(`/providers?page=${page}&search=${encodeURIComponent(search)}`);
  return <div className="form-stack"><div className="flex gap-2"><Input aria-label="搜索 Cloudflare 服务商" placeholder="按名称或 slug 搜索" value={input} onChange={e => setInput(e.target.value)} /><Button type="button" variant="secondary" onClick={() => { setSearch(input); setPage(1); }}><Search size={15} />搜索</Button></div><ErrorBox message={providers.error} /><Field label="Cloudflare 服务商"><Select value={selected} required onChange={value => { const provider = providers.data?.data.find(p => p.id === value); if (provider) onSelect(provider); }}><option value="">请选择</option>{selected && !providers.data?.data.some(p => p.id === selected) && <option value={selected}>{selected}</option>}{providers.data?.data.map(p => <option value={p.id} key={p.id}>{p.name} · {p.slug}{p.enable === false ? '（已停用）' : ''}</option>)}</Select></Field><div className="flex justify-between items-center"><Button type="button" variant="ghost" disabled={page === 1 || providers.loading} onClick={() => setPage(p => p - 1)}>上一页</Button><span className="muted">第 {page} 页</span><Button type="button" variant="ghost" disabled={!providers.data?.has_more || providers.loading} onClick={() => setPage(p => p + 1)}>下一页</Button></div></div>;
}
function ChannelForm({ channel, onClose }: { channel: Channel | null; onClose: () => void }) {
  const [name, setName] = useState(channel?.name || ''), [kind, setKind] = useState<Channel['kind']>(channel?.kind || 'openai');
  const [profile, setProfile] = useState<ProviderProfile>({ protocol: channel?.protocol || 'openai', tags: channel?.tags || [], models: channel?.models || [] });
  const [mode, setMode] = useState(channel?.provider_id ? 'existing' : 'new');
  const [providerId, setProviderId] = useState(channel?.provider_id || ''), [slug, setSlug] = useState(channel?.provider_slug || '');
  const [url, setUrl] = useState(channel?.base_url || ''), [path, setPath] = useState(channel?.gateway_path || 'v1/chat/completions');
  const [alias, setAlias] = useState(channel?.byok_alias || ''), [secret, setSecret] = useState('');
  const [credentialMode, setCredentialMode] = useState(channel?.kind === 'openai' && channel.byok_alias && !channel.has_secret ? 'byok' : 'local');
  const [timeout, setTimeoutValue] = useState((channel?.timeout_ms || 60000) / 1000), [enabled, setEnabled] = useState(channel ? !!channel.enabled : true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      await api(`/channels${channel ? `/${channel.id}` : ''}`, { method: channel ? 'PUT' : 'POST', body: JSON.stringify({ ...profile, name, kind, base_url: url, secret: kind !== 'openai' || credentialMode === 'local' ? secret || undefined : undefined, credential_mode: kind === 'openai' ? credentialMode : undefined, timeout_ms: timeout * 1000, enabled, provider_id: mode === 'existing' ? providerId : undefined, provider_slug: slug || undefined, gateway_path: path, byok_alias: kind === 'openai' && credentialMode === 'byok' ? alias : '' }) });
      refresh(); notify(channel ? '渠道已更新' : '渠道已接入 AI Gateway'); onClose();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <Modal title={channel ? '编辑渠道' : '添加 AI Gateway 渠道'} description="所有自定义服务商调用都经过 Cloudflare AI Gateway。" onClose={onClose}><form onSubmit={submit} className="form-stack">
    <FormSection number="01" title="渠道标识"><Field label="本地渠道名称"><Input required maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="例如：我的模型服务" autoFocus /></Field>
    <Field label="接入方式"><Select value={kind} onChange={value => { setKind(value as Channel['kind']); setSecret(''); }}>{Object.entries(channelLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
    </FormSection><FormSection number="02" title="上游连接">{kind === 'openai' ? <>
      {!channel?.provider_id && <Field label="服务商来源"><Select value={mode} onChange={value => { setMode(value); setProviderId(''); }}><option value="new">在 Cloudflare 创建新服务商</option><option value="existing">关联已有 Cloudflare 服务商</option></Select></Field>}
      {mode === 'existing' ? <><ProviderPicker selected={providerId} onSelect={provider => { setProviderId(provider.id); setSlug(provider.slug); setUrl(provider.base_url); setProfile({ protocol: provider.protocol, tags: provider.tags, models: provider.models }); setAlias(''); setSecret(''); setPath(`${new URL(provider.base_url).pathname.replace(/\/+$/, '').endsWith('/v1') ? '' : 'v1/'}${provider.protocol === 'anthropic' ? 'messages' : 'chat/completions'}`); }} /><div className="info-note">服务商地址：{url || '选择服务商后显示'}<br />修改账户级服务商信息请使用“Cloudflare 服务商”页签。</div></> : <><Field label="服务商 Slug" hint="在 Cloudflare 账户内唯一，小写字母、数字和短横线；无需添加 custom- 前缀。"><Input required value={slug} pattern="[a-z0-9]+(-[a-z0-9]+)*" onChange={e => setSlug(e.target.value)} placeholder="my-provider" /></Field><Field label="服务商 Base URL" hint="填写根域名或固定路径前缀，下面的请求路径会原样追加。"><Input type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://api.example.com" /></Field></>}
      <ProviderFields key={`${mode}:${providerId}`} value={profile} readOnly={mode === 'existing'} onChange={value => { if (value.protocol !== profile.protocol) setPath(previous => previous.replace(/(?:chat\/completions|messages)$/, value.protocol === 'anthropic' ? 'messages' : 'chat/completions')); setProfile(value); }} />
      <Field label="推理请求路径" hint="OpenAI 通常为 v1/chat/completions，Anthropic 为 v1/messages；Base URL 已包含 /v1 时省略该前缀。"><Input required value={path} onChange={e => setPath(e.target.value)} placeholder="v1/chat/completions" /></Field>
      <Field label="凭据保存方式"><Select value={credentialMode} onChange={value => { setCredentialMode(value); setSecret(''); }}><option value="local">程序加密存储（推荐）</option><option value="byok">使用已有 Cloudflare BYOK 别名</option></Select></Field>
      {credentialMode === 'local' ? <Field label="供应商 API Key" hint="加密保存在本程序数据库，调用时由 AI Gateway 转发给供应商，无需 Secrets Store。编辑时留空保留原密钥；更换服务商或请求地址需重新填写。"><Input type="password" autoComplete="new-password" required={!(channel?.kind === 'openai' && channel.has_secret)} value={secret} onChange={e => setSecret(e.target.value)} placeholder={channel?.kind === 'openai' && channel.has_secret ? '已加密保存，留空保持不变' : '输入供应商 API Key'} /></Field>
        : <Field label="已有 BYOK 别名" hint="填写此服务商在当前 AI Gateway 中已配置的别名。程序不会上传或修改 Cloudflare 的密钥。"><Input value={alias} onChange={e => setAlias(e.target.value)} placeholder="例如 default" required /></Field>}
      {channel?.has_secret && !channel.provider_id && <div className="info-note">此渠道来自旧版直连配置。关联到相同上游地址后可继续使用已加密的密钥，推理会经过 AI Gateway。</div>}
    </> : <><div className="info-note">{kind === 'cloudflare' ? '使用 Cloudflare AI REST API 与统一计费。' : '调用 AI Gateway 的内置模型或 dynamic/ 动态路由；供应商凭据在 Cloudflare BYOK 配置。'} Account ID 和 Gateway ID 在 Worker 环境变量中配置。</div><Field label="Cloudflare Token（可选覆盖）" hint={`留空使用 ${kind === 'cloudflare' ? 'CF_AI_TOKEN' : 'CF_AIG_TOKEN / CF_API_TOKEN'}。`}><Input type="password" autoComplete="new-password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={channel?.has_secret ? '已保存，留空保持不变' : '使用 Worker Secret'} /></Field></>}
    </FormSection><FormSection number="03" title="运行策略"><Field label="请求超时（秒）"><Input type="number" min={1} max={120} required value={timeout} onChange={e => setTimeoutValue(Number(e.target.value))} /></Field><Toggle checked={enabled} onChange={setEnabled} label="启用本地渠道" /></FormSection>
    <ErrorBox message={error} /><div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>取消</Button><Button disabled={busy}>{busy ? '正在配置 Cloudflare…' : '保存渠道'}</Button></div></form></Modal>;
}
function ProviderForm({ provider, onClose }: { provider: CustomProvider | null; onClose: () => void }) {
  const [profile, setProfile] = useState<ProviderProfile>({ protocol: provider?.protocol || 'openai', tags: provider?.tags || [], models: provider?.models || [] });
  const [name, setName] = useState(provider?.name || ''), [slug, setSlug] = useState(provider?.slug || ''), [url, setUrl] = useState(provider?.base_url || ''), [description, setDescription] = useState(provider?.description || ''), [enable, setEnable] = useState(provider?.enable !== false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await api(`/providers${provider ? `/${provider.id}` : ''}`, { method: provider ? 'PATCH' : 'POST', body: JSON.stringify({ ...profile, name, slug, base_url: url, description, enable }) }); refresh(); notify('Cloudflare 服务商已保存'); onClose(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <Modal title={provider ? '编辑 Cloudflare 服务商' : '创建 Cloudflare 服务商'} description="这是账户级资源，同一账户的其他 AI Gateway 也会使用此配置。" onClose={onClose}><form onSubmit={submit} className="form-stack"><FormSection number="01" title="服务商标识"><Field label="名称"><Input required value={name} onChange={e => setName(e.target.value)} /></Field><Field label="Slug"><Input required disabled={!!provider} value={slug} onChange={e => setSlug(e.target.value)} pattern="[a-z0-9]+(-[a-z0-9]+)*" /></Field><Field label="Base URL" hint={provider ? '切换服务地址请新建服务商，避免影响已绑定的凭据。' : '填写 HTTPS 根域名或固定路径前缀。'}><Input type="url" required disabled={!!provider} value={url} onChange={e => setUrl(e.target.value)} /></Field></FormSection><FormSection number="02" title="协议与资源"><ProviderFields value={profile} onChange={setProfile} /></FormSection><FormSection number="03" title="状态与备注"><Field label="描述"><Input value={description} onChange={e => setDescription(e.target.value)} maxLength={500} /></Field><Toggle label="在 Cloudflare 启用此服务商" checked={enable} onChange={setEnable} /></FormSection><ErrorBox message={error} /><div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button disabled={busy}>{busy ? '保存中…' : '保存到 Cloudflare'}</Button></div></form></Modal>;
}
function Providers() {
  const [page, setPage] = useState(1), [editing, setEditing] = useState<CustomProvider | null | undefined>(), [deleting, setDeleting] = useState<CustomProvider | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const providers = useApi<ProviderPage>(`/providers?page=${page}`), { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  async function remove() { setBusy(true); setError(''); try { await api(`/providers/${deleting!.id}`, { method: 'DELETE' }); refresh(); setDeleting(null); notify('Cloudflare 服务商已删除'); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }
  return <><div className="section-toolbar"><div className="resource-counters"><span><strong>{providers.data?.total ?? '—'}</strong>账户服务商</span></div><Button onClick={() => setEditing(null)}><Plus size={16} />创建服务商</Button></div><ErrorBox message={providers.error} />
    {providers.loading ? <Loading /> : providers.data?.data.length ? <div className="provider-grid">{providers.data.data.map(provider => <article className="surface cloud-provider-card" key={provider.id}>
      <header><span className="square-icon"><Cloud size={22} /></span><div><h2>{provider.name}</h2><code>custom-{provider.slug}</code></div><Badge tone={provider.enable === false ? 'neutral' : 'green'}>{provider.enable === false ? '已停用' : '已启用'}</Badge></header>
      <div className="provider-address"><span className="mini-label">BASE URL</span><code>{provider.base_url}</code></div>
      <div className="provider-profile"><div><span className="mini-label">协议</span><strong>{provider.protocol === 'anthropic' ? 'Anthropic Messages' : 'OpenAI Chat Completions'}</strong></div><div><span className="mini-label">模型清单</span><strong>{provider.models.length} 个模型</strong></div></div>
      <div className="tag-list">{provider.tags.length ? provider.tags.map(tag => <Badge key={tag}>{tag}</Badge>) : <span className="muted">未设置标签</span>}</div>
      <footer><span className="surface-caption">CLOUDFLARE RESOURCE</span><div className="row-actions"><Button variant="secondary" aria-label={`编辑服务商 ${provider.name}`} onClick={() => setEditing(provider)}><Pencil size={15} />编辑</Button><Button variant="ghost" className="icon-btn danger-text" aria-label={`删除服务商 ${provider.name}`} onClick={() => { setDeleting(provider); setError(''); }}><Trash2 size={16} /></Button></div></footer>
    </article>)}</div> : !providers.error && <section className="surface"><Empty title="Cloudflare 暂无自定义服务商" description="创建服务商后即可在本地渠道中关联。" action={<Button variant="secondary" onClick={() => setEditing(null)}><Plus size={16} />创建服务商</Button>} /></section>}
    <div className="pagination provider-pagination"><span>第 {page} 页 · {providers.data?.total ?? '—'} 个服务商</span><div><Button variant="secondary" disabled={page === 1 || providers.loading} onClick={() => setPage(p => p - 1)}>上一页</Button><Button variant="secondary" disabled={!providers.data?.has_more || providers.loading} onClick={() => setPage(p => p + 1)}>下一页</Button></div></div>
    {editing !== undefined && <ProviderForm provider={editing} onClose={() => setEditing(undefined)} />}{deleting && <Confirm title={`从 Cloudflare 删除 ${deleting.name}？`} description="这会删除账户级服务商，其他应用或 Gateway 使用它的请求也会中断。本程序无法检测其他应用的依赖，请确认已停止使用。" onConfirm={remove} onClose={() => setDeleting(null)} busy={busy} error={error} />}</>;

}
export function Channels() {
  const { data, error, loading } = useApi<Channel[]>('/channels');
  const [tab, setTab] = useState('channels'), [editing, setEditing] = useState<Channel | null | undefined>(), [deleting, setDeleting] = useState<Channel | null>(null);
  const [busy, setBusy] = useState(false), [deleteError, setDeleteError] = useState('');
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  async function remove() { setBusy(true); setDeleteError(''); try { await api(`/channels/${deleting!.id}`, { method: 'DELETE' }); setDeleting(null); refresh(); notify('本地渠道已删除，Cloudflare 服务商保留'); } catch (err) { setDeleteError((err as Error).message); } finally { setBusy(false); } }
  const [search, setSearch] = useState(''), [protocol, setProtocol] = useState('all');
  const filtered = data?.filter(channel => `${channel.name} ${channel.provider_slug || ''} ${channel.tags.join(' ')}`.toLowerCase().includes(search.toLowerCase()) && (protocol === 'all' || channel.protocol === protocol));
  return <>
    <PageTitle eyebrow="02 / CONNECTIONS" title="渠道与服务商" description="连接上游，管理协议，组织你的模型资源。" action={<Button onClick={() => setEditing(null)}><Plus size={17} />添加渠道</Button>} />
    <Tabs selectedKey={tab} onSelectionChange={key => setTab(String(key))} className="workspace-tabs"><Tabs.ListContainer><Tabs.List aria-label="渠道管理视图"><Tabs.Tab id="channels"><Radio size={16} />本地渠道<Tabs.Indicator /></Tabs.Tab><Tabs.Tab id="providers"><Cloud size={17} />Cloudflare 服务商<Tabs.Indicator /></Tabs.Tab></Tabs.List></Tabs.ListContainer><Tabs.Panel id={tab}>
      {tab === 'providers' ? <Providers /> : <>
        <ErrorBox message={error} />
        <div className="resource-toolbar"><div className="resource-counters"><span><strong>{data?.length ?? '—'}</strong>全部渠道</span><span><strong className="accent-text">{data?.filter(channel => channel.enabled && channel.configured).length ?? '—'}</strong>已配置</span></div><div className="toolbar-filters"><div className="search-field"><Search size={17} /><Input aria-label="搜索渠道" placeholder="搜索渠道或标签" value={search} onChange={e => setSearch(e.target.value)} /></div><Select aria-label="筛选服务商协议" value={protocol} onChange={setProtocol}><option value="all">全部协议</option><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option></Select></div></div>
        <section className="surface connection-register">{loading && !data ? <Loading /> : !filtered?.length ? <Empty title={search || protocol !== 'all' ? '没有匹配的渠道' : '连接第一个模型服务商'} description="关联 Cloudflare 自定义服务商，配置协议与模型清单。" action={<Button variant="secondary" onClick={() => setEditing(null)}><Plus size={17} />添加渠道</Button>} /> : <>
          <div className="connection-row connection-labels"><span>渠道 / 端点</span><span>协议与标签</span><span>模型</span><span>配置状态</span><span>操作</span></div>
          {filtered.map(channel => <article className="connection-row" key={channel.id}>
            <div className="connection-identity"><span className={`provider-monogram ${channel.protocol}`}>{channel.protocol === 'anthropic' ? 'A' : <Cloud size={23} />}</span><div><h2>{channel.name}</h2><code>{channel.provider_slug ? `custom-${channel.provider_slug}` : channelLabel[channel.kind]}</code></div></div>
            <div className="connection-protocol"><strong>{channel.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}</strong><div className="tag-list">{channel.tags.length ? channel.tags.map(tag => <Badge key={tag}>{tag}</Badge>) : <span className="muted">未设置标签</span>}</div></div>
            <div className="connection-models"><Layers size={16} /><strong>{channel.models.length}</strong><small>个模型</small></div>
            <div className="connection-state"><Badge tone={!channel.enabled ? 'neutral' : channel.configured ? 'green' : 'amber'}>{!channel.enabled ? '已停用' : channel.configured ? '已配置' : '待配置'}</Badge><small>超时 {channel.timeout_ms / 1000}s</small></div>
            <div className="row-actions"><Button variant="secondary" aria-label={`编辑渠道 ${channel.name}`} onClick={() => setEditing(channel)}><Pencil size={15} />编辑</Button><Button variant="ghost" className="icon-btn danger-text" aria-label={`删除渠道 ${channel.name}`} onClick={() => { setDeleting(channel); setDeleteError(''); }}><Trash2 size={16} /></Button></div>
          </article>)}
        </>}</section><p className="page-footnote">配置状态反映本地连接信息的完整性，不代表上游实时可用性。</p>
      </>}
    </Tabs.Panel></Tabs>
    <div className="security-note"><Cloud size={22} /><div><strong>请求经由 Cloudflare AI Gateway</strong><p>供应商密钥默认由本程序加密保存；缓存、日志与费用配置由 Cloudflare 管理。</p></div><a className="text-link" href="https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/" target="_blank" rel="noreferrer">查看文档<ArrowUpRight size={16} /></a></div>
    {editing !== undefined && <ChannelForm channel={editing} onClose={() => setEditing(undefined)} />}
    {deleting && <Confirm title={`删除本地渠道 ${deleting.name}？`} description="此渠道、加密保存的密钥及其模型路由会被移除。Cloudflare 的服务商、已有 BYOK 密钥与日志会保留。" onConfirm={remove} onClose={() => setDeleting(null)} busy={busy} error={deleteError} />}
  </>;
}
