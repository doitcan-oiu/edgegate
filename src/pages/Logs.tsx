import { useState } from 'react';
import { ChevronLeft, ChevronRight, Cloud, Filter, Search } from 'lucide-react';
import { useApi } from '../lib';
import type { Log, LogPage } from '../types';
import { Button, Empty, ErrorBox, Loading, LogDetail, LogTable, PageTitle, Input, Select, Modal, Field } from '../components';
import type { UpstreamErrorTrace } from '../../shared/gateway-settings';
import { ErrorTrace } from '../ErrorTrace';

function TraceResults({ requestId }: { requestId: string }) {
  const { data, error, loading } = useApi<UpstreamErrorTrace[]>(`/traces/${encodeURIComponent(requestId)}`);
  return <div className="error-trace-list"><ErrorBox message={error} />{loading ? <Loading /> : data?.length ? data.map(trace => <ErrorTrace key={trace.attempt} trace={trace} />) : !error && <p className="runtime-hint">未找到上游错误。请求可能未发生上游故障，或已超过 7 天保留期。</p>}</div>;
}
function RequestTrace({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState(''), [requestId, setRequestId] = useState('');
  return <Modal title="请求追踪" description="通过响应中的 X-Request-ID 查看每次失败的原始上游错误。错误保留 7 天，不受对外展示设置影响。" onClose={onClose}><form className="trace-search" onSubmit={event => { event.preventDefault(); setRequestId(draft.trim()); }}><Field label="EdgeGate 请求 ID"><Input required pattern="[a-fA-F0-9-]{36}" value={draft} onChange={event => setDraft(event.target.value)} placeholder="输入 X-Request-ID" autoFocus /></Field><Button type="submit">查询</Button></form>{requestId && <TraceResults key={requestId} requestId={requestId} />}</Modal>;
}

export function Logs() {
  const [tracing, setTracing] = useState(false);
  const [page, setPage] = useState(1), [status, setStatus] = useState('all'), [model, setModel] = useState(''), [draft, setDraft] = useState(''), [selected, setSelected] = useState<Log | null>(null);
  const logs = useApi<LogPage>(`/logs?${new URLSearchParams({ page: String(page), status, model })}`);
  return <><PageTitle title="请求日志" description="追踪每一次上游调用，检查响应状态与请求详情。" action={<Button variant="secondary" onClick={() => setTracing(true)}><Search size={16} />请求追踪</Button>} /><ErrorBox message={logs.error} />{tracing && <RequestTrace onClose={() => setTracing(false)} />}
    <div className="log-summary"><span><strong>{logs.data?.total ?? '—'}</strong>匹配日志</span><span className="log-success-count"><strong>{logs.data?.data.filter(log => log.success).length ?? '—'}</strong>本页成功</span><span className="log-error-count"><strong>{logs.data?.data.filter(log => !log.success).length ?? '—'}</strong>本页失败</span><span className="log-scope"><Cloud size={16} />Cloudflare AI Gateway</span></div>
    <section className="surface logs-workspace"><div className="log-toolbar"><div className="inline-heading"><Filter size={16} className="muted" /><Select aria-label="筛选请求状态" value={status} onChange={value => { setStatus(value); setPage(1); }}><option value="all">全部状态</option><option value="success">请求成功</option><option value="error">请求失败</option></Select></div><form className="filter-form" onSubmit={e => { e.preventDefault(); setModel(draft.trim()); setPage(1); }}><Input aria-label="筛选上游模型" placeholder="上游模型 ID（精确匹配）" value={draft} onChange={e => setDraft(e.target.value)} /><Button variant="secondary">筛选</Button></form></div>
    {logs.loading ? <Loading /> : logs.data?.data.length ? <LogTable logs={logs.data.data} onSelect={setSelected} /> : !logs.error && <Empty title="没有匹配的 Cloudflare 日志" description="确认 AI Gateway 已开启日志采集；新请求可能需要稍等后才可查询。" />}
    <div className="pagination"><span>第 {page}{logs.data?.total != null ? ` / ${Math.max(1, Math.ceil(logs.data.total / 25))}` : ''} 页 · 每页 25 条</span><div><Button variant="secondary" aria-label="上一页" disabled={page === 1 || logs.loading} onClick={() => setPage(p => p - 1)}><ChevronLeft size={16} /></Button><Button variant="secondary" aria-label="下一页" disabled={!logs.data?.has_more || logs.loading} onClick={() => setPage(p => p + 1)}><ChevronRight size={16} /></Button></div></div></section>
    <p className="page-footnote">范围为当前 Gateway 的全部调用，包含其他客户端。一次 EdgeGate 请求若尝试多个上游，可能对应多条 Cloudflare 日志，可通过详情中的 EdgeGate 请求 ID 关联。Worker 提前拒绝的鉴权或配额请求不会进入 AI Gateway。</p>{selected && <LogDetail log={selected} onClose={() => setSelected(null)} />}</>;
}
