import { useContext, useState, type FormEvent } from 'react';
import { Copy, KeyRound, Plus, Search, ShieldCheck, Trash2 } from 'lucide-react';
import type { ApiKey, Model } from '../types';
import { api, copy, number, RefreshContext, time, ToastContext, useApi } from '../lib';
import { Badge, Button, Confirm, Empty, ErrorBox, Field, Loading, Modal, PageTitle, Checkbox, Input, FormSection } from '../components';

function KeyForm({ models, tags, onClose, onCreated }: { models: Model[]; tags: string[]; onClose: () => void; onCreated: (key: string) => void }) {
  const [name, setName] = useState(''), [rpm, setRpm] = useState(60), [daily, setDaily] = useState(0), [expiry, setExpiry] = useState(''), [allowed, setAllowed] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { refresh } = useContext(RefreshContext);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { const data = await api<{ key: string }>('/keys', { method: 'POST', body: JSON.stringify({ name, rpm, daily_limit: daily, expires_at: expiry ? new Date(expiry).toISOString() : null, allowed_models: allowed, allowed_tags: selectedTags }) }); refresh(); onCreated(data.key); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <Modal title="创建 API 密钥" description="为每个应用创建独立密钥，分别管理权限和用量。" onClose={onClose}><form onSubmit={submit} className="form-stack"><FormSection number="01" title="应用与用量"><Field label="密钥名称"><Input required value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="例如：生产环境 · 客服应用" autoFocus /></Field><div className="form-columns"><Field label="每分钟请求上限"><Input type="number" min={1} max={10000} required value={rpm} onChange={e => setRpm(Number(e.target.value))} /></Field><Field label="每日请求上限" hint="0 表示不限；UTC 零点重置"><Input type="number" min={0} max={100000000} required value={daily} onChange={e => setDaily(Number(e.target.value))} /></Field></div><Field label="过期时间（可选）"><Input type="datetime-local" value={expiry} onChange={e => setExpiry(e.target.value)} /></Field></FormSection><fieldset className="model-permissions"><legend>允许访问的服务商标签</legend><p>留空不限制标签；勾选后匹配任意所选标签。模型列表合并这些服务商的所有可用模型，实际调用及故障转移也遵守此范围。</p><div className="permission-options">{tags.length ? tags.map(tag => <Checkbox key={tag} checked={selectedTags.includes(tag)} onChange={checked => setSelectedTags(checked ? [...selectedTags, tag] : selectedTags.filter(value => value !== tag))}>{tag}</Checkbox>) : <p>暂无标签，请先在服务商配置中添加。</p>}</div></fieldset><fieldset className="model-permissions"><legend>允许访问的模型</legend><p>不勾选表示允许标签范围内的所有模型（包括后续新增模型）；勾选后与标签范围取交集。</p><div className="permission-options">{models.map(model => <Checkbox key={model.id} checked={allowed.includes(model.id)} onChange={checked => setAllowed(checked ? [...allowed, model.id] : allowed.filter(id => id !== model.id))}><span className="mono">{model.id}</span></Checkbox>)}</div></fieldset><ErrorBox message={error} /><div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button disabled={busy}>{busy ? '创建中…' : '创建密钥'}</Button></div></form></Modal>;
}
export function Keys() {
  const keys = useApi<ApiKey[]>('/keys'), models = useApi<Model[]>('/models'), tags = useApi<string[]>('/tags');
  const [creating, setCreating] = useState(false), [created, setCreated] = useState(''), [revoke, setRevoke] = useState<ApiKey | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  const [search, setSearch] = useState('');
  const filtered = keys.data?.filter(key => `${key.name} ${key.prefix} ${key.allowed_tags.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const activeCount = keys.data?.filter(key => !key.revoked_at && (!key.expires_at || Date.parse(key.expires_at) > Date.now())).length;
  async function remove() {
    setBusy(true); setError('');
    try { await api(`/keys/${revoke!.id}`, { method: 'DELETE' }); refresh(); setRevoke(null); notify('密钥已撤销'); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <>
    <PageTitle eyebrow="04 / ACCESS CONTROL" title="应用密钥" description="为每个应用划定清晰的访问边界。" action={<Button onClick={() => setCreating(true)}><Plus size={17} />创建密钥</Button>} />
    <ErrorBox message={keys.error || models.error || tags.error} />
    <div className="resource-toolbar"><div className="resource-counters"><span><strong>{keys.data?.length ?? '—'}</strong>全部密钥</span><span><strong className="accent-text">{activeCount ?? '—'}</strong>有效密钥</span></div><div className="search-field"><Search size={17} /><Input aria-label="搜索密钥" placeholder="搜索名称、前缀或标签" value={search} onChange={e => setSearch(e.target.value)} /></div></div>
    {keys.loading && !keys.data ? <Loading /> : !filtered?.length ? <section className="surface"><Empty title={search ? '没有匹配的密钥' : '给你的应用一把钥匙'} description="独立凭据、标签权限与请求配额，在一处管理。" action={!search && <Button onClick={() => setCreating(true)}><KeyRound size={17} />创建密钥</Button>} /></section> : <div className="credential-grid">{filtered.map(key => {
      const expired = !!key.expires_at && Date.parse(key.expires_at) <= Date.now(), active = !key.revoked_at && !expired;
      return <article className={`credential-card surface ${active ? '' : 'credential-inactive'}`} key={key.id}>
        <div className="credential-heading"><span className="square-icon"><KeyRound size={20} /></span><div><h2>{key.name}</h2><span>{key.expires_at ? `${time(key.expires_at)} 到期` : '长期有效'}</span></div><Badge tone={active ? 'green' : 'neutral'}>{key.revoked_at ? '已撤销' : expired ? '已过期' : '有效'}</Badge></div>
        <div className="credential-token"><code>{key.prefix}<span>•••• •••• ••••</span></code><ShieldCheck size={16} /></div>
        <div className="credential-scope"><span className="mini-label">服务商标签</span><div className="tag-list">{key.allowed_tags.length ? key.allowed_tags.map(tag => <Badge key={tag} tone="green">{tag}</Badge>) : <span className="muted">所有服务商</span>}</div><span className="mini-label">模型范围</span><p className="mono">{key.allowed_models.length ? key.allowed_models.join(' · ') : '标签范围内的所有模型'}</p></div>
        <div className="credential-usage"><div><span>今日请求</span><strong className="mono">{number(key.requests_today || 0)} <small>/ {key.daily_limit ? number(key.daily_limit) : '不限'}</small></strong></div>{key.daily_limit > 0 && <div className="usage-track"><i style={{ width: `${Math.min(100, (key.requests_today || 0) / key.daily_limit * 100)}%` }} /></div>}</div>
        <footer><span className="mono">{number(key.rpm)} <small>RPM</small></span><Button variant="ghost" className="danger-text" aria-label={`撤销密钥 ${key.name}`} disabled={!!key.revoked_at} onClick={() => { setRevoke(key); setError(''); }}><Trash2 size={15} />撤销密钥</Button></footer>
      </article>;
    })}</div>}
    <div className="security-note"><ShieldCheck size={20} /><div><strong>原文只展示一次，权限实时生效。</strong><p>密钥仅保存哈希。使用 Bearer 或 x-api-key 调用网关；撤销后新的请求会立即被拒绝。</p></div></div>
    {creating && <KeyForm models={models.data || []} tags={tags.data || []} onClose={() => setCreating(false)} onCreated={key => { setCreating(false); setCreated(key); }} />}
    {created && <Modal presentation="dialog" title="密钥已创建" description="原文只在这里展示一次，关闭后无法再次查看。" onClose={() => setCreated('')}><div className="secret-reveal"><code>{created}</code><Button variant="secondary" onClick={() => copy(created, notify)}><Copy size={16} />复制密钥</Button></div><div className="info-note">请保存在应用服务端的环境变量中，不要放入前端代码或提交到 Git。</div><div className="modal-actions"><Button onClick={() => setCreated('')}>已保存，关闭</Button></div></Modal>}
    {revoke && <Confirm title={`撤销 ${revoke.name}？`} description="使用该密钥的应用将无法继续请求网关。此操作不可恢复，可创建新密钥替换。" onConfirm={remove} onClose={() => setRevoke(null)} busy={busy} error={error} />}</>;
}
