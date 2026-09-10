import { useState } from 'react';
import { ChevronLeft, ChevronRight, Cloud, Filter } from 'lucide-react';
import { useApi } from '../lib';
import type { Log, LogPage } from '../types';
import { Button, Empty, ErrorBox, Loading, LogDetail, LogTable, PageTitle, Input, Select } from '../components';

export function Logs() {
  const [page, setPage] = useState(1), [status, setStatus] = useState('all'), [model, setModel] = useState(''), [draft, setDraft] = useState(''), [selected, setSelected] = useState<Log | null>(null);
  const logs = useApi<LogPage>(`/logs?${new URLSearchParams({ page: String(page), status, model })}`);
  return <><PageTitle eyebrow="05 / REQUEST LOGS" title="请求日志" description="追踪每一次上游调用，检查响应状态与请求详情。" /><ErrorBox message={logs.error} />
    <div className="log-summary"><span><strong>{logs.data?.total ?? '—'}</strong>匹配日志</span><span><strong>{logs.data?.data.filter(log => log.success).length ?? '—'}</strong>本页成功</span><span><strong>{logs.data?.data.filter(log => !log.success).length ?? '—'}</strong>本页失败</span><span className="log-scope"><Cloud size={16} />Cloudflare AI Gateway</span></div>
    <section className="surface"><div className="log-toolbar"><div className="inline-heading"><Filter size={16} className="muted" /><Select aria-label="筛选请求状态" value={status} onChange={value => { setStatus(value); setPage(1); }}><option value="all">全部状态</option><option value="success">请求成功</option><option value="error">请求失败</option></Select></div><form className="filter-form" onSubmit={e => { e.preventDefault(); setModel(draft.trim()); setPage(1); }}><Input aria-label="筛选上游模型" placeholder="上游模型 ID（精确匹配）" value={draft} onChange={e => setDraft(e.target.value)} /><Button variant="secondary">筛选</Button></form></div>
    {logs.loading ? <Loading /> : logs.data?.data.length ? <LogTable logs={logs.data.data} onSelect={setSelected} /> : !logs.error && <Empty title="没有匹配的 Cloudflare 日志" description="确认 AI Gateway 已开启日志采集；新请求可能需要稍等后才可查询。" />}
    <div className="pagination"><span>第 {page}{logs.data?.total != null ? ` / ${Math.max(1, Math.ceil(logs.data.total / 25))}` : ''} 页 · 每页 25 条</span><div><Button variant="secondary" aria-label="上一页" disabled={page === 1 || logs.loading} onClick={() => setPage(p => p - 1)}><ChevronLeft size={16} /></Button><Button variant="secondary" aria-label="下一页" disabled={!logs.data?.has_more || logs.loading} onClick={() => setPage(p => p + 1)}><ChevronRight size={16} /></Button></div></div></section>
    <p className="page-footnote">范围为当前 Gateway 的全部调用，包含其他客户端。一次 EdgeGate 请求若尝试多个上游，可能对应多条 Cloudflare 日志，可通过详情中的 EdgeGate 请求 ID 关联。Worker 提前拒绝的鉴权或配额请求不会进入 AI Gateway。</p>{selected && <LogDetail log={selected} onClose={() => setSelected(null)} />}</>;
}
