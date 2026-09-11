import { useContext, useEffect, useRef, useState } from 'react';
import { Database, RefreshCw } from 'lucide-react';
import { api, number, RefreshContext, time, ToastContext, useApi } from './lib';
import { Button, ErrorBox, Field, Loading, Select } from './components';
import type { ObservabilityStatus, SyncJobName, SyncJobStatus } from '../shared/observability';
import './observability.css';

const names: Record<SyncJobName, string> = { 'stats:24h': '24 小时统计', 'stats:7d': '7 天统计', 'logs:head': '最新日志', 'logs:repair': '近期日志复查', 'logs:history': '历史日志回补' };
function stateText(job: SyncJobStatus) {
  return job.state === 'running' ? '同步中' : job.state === 'queued' ? '已排队' : job.state === 'error' ? '同步失败' : job.state === 'waiting' ? '等待首次同步' : job.stale ? '数据待更新' : '已同步';
}

export function ObservabilitySync({ settings = false, jobs = ['stats:24h', 'logs:head'] }: { settings?: boolean; jobs?: SyncJobName[] }) {
  const [tick, setTick] = useState(0), [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const [retention, setRetention] = useState<7 | 30 | null>(null);
  const status = useApi<ObservabilityStatus>(`/observability?view=${tick}`), notify = useContext(ToastContext), { refresh } = useContext(RefreshContext);
  const previous = useRef<string | null>(null);
  const signature = status.data?.jobs.map(job => job.last_success_at || '').join('|');
  const pending = status.data?.jobs.some(job => ['waiting', 'queued', 'running'].includes(job.state));
  useEffect(() => {
    if (!pending) return;
    // Poll only D1 status while waiting. Closing this page does not stop the job.
    const timer = window.setInterval(() => { if (!document.hidden) setTick(value => value + 1); }, 10000);
    return () => window.clearInterval(timer);
  }, [pending]);
  useEffect(() => {
    if (signature === undefined) return;
    const changed = previous.current !== null && previous.current !== signature;
    previous.current = signature;
    if (changed) refresh();
  }, [signature, refresh]);
  async function sync() {
    setBusy(true); setError('');
    try { await api('/observability/sync', { method: 'POST' }); refresh(); notify('同步已排队，将在下一分钟内开始；可以关闭网页'); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function save() {
    setSaving(true); setError('');
    try { await api('/config/observability', { method: 'PUT', body: JSON.stringify({ log_retention_days: retention }) }); refresh(); setRetention(null); notify('日志保留期已保存'); }
    catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  }
  const visible = status.data?.jobs.filter(job => settings || jobs.includes(job.job)) || [];
  const active = status.data?.jobs.some(job => job.state === 'queued' || job.state === 'running');
  return <div className={settings ? 'sync-settings' : 'sync-overview'}>
    <div className="sync-toolbar"><span><Database size={15} />{settings ? '后台数据同步' : 'D1 缓存'}</span>
      <Button variant="secondary" disabled={busy || active} onClick={sync}><RefreshCw size={14} />{busy ? '提交中…' : active ? '同步已安排' : '立即同步'}</Button>
    </div>
    <ErrorBox message={error || status.error} />
    {settings && <p className="sync-help">定时从 Cloudflare 获取数据，网页关闭后仍会同步。接口失败时继续显示上次成功的数据。</p>}
    {settings && status.loading && !status.data ? <Loading /> : <div className="sync-jobs">{visible.map(job => <div className={`sync-job ${job.state === 'error' ? 'has-error' : ''}`} key={job.job}>
      <span>{names[job.job]}</span><span className="sync-job-state">{stateText(job)}</span><time>{job.last_success_at ? time(job.last_success_at) : '暂无成功记录'}</time>
      {settings && job.last_attempt_at && <small>最近尝试 {time(job.last_attempt_at)}</small>}
      {job.last_error && <p>{job.last_error}{job.last_success_at ? '，保留上次数据。' : '。'}</p>}
    </div>)}</div>}
    {settings && status.data && <>
      <div className="sync-cadence"><span>最新日志 <strong>2 分钟</strong></span><span>24 小时统计 <strong>5 分钟</strong></span><span>7 天统计 <strong>15 分钟</strong></span></div>
      <div className="sync-retention"><Field label="日志保留期" hint="延长后自动回补仍可从 Cloudflare 查询的日志；缩短后立即按新范围展示，并分批清理过期数据。"><Select value={String(retention ?? status.data.settings.log_retention_days)} disabled={saving} onChange={value => setRetention(Number(value) as 7 | 30)}><option value="7">7 天</option><option value="30">30 天</option></Select></Field><Button disabled={saving || retention === null || retention === status.data.settings.log_retention_days} onClick={save}>{saving ? '保存中…' : '保存保留期'}</Button></div>
      <div className="sync-coverage"><strong>本地已同步 {number(status.data.logs.total)} 条日志</strong><span>{status.data.logs.oldest_at ? `最早记录 ${time(status.data.logs.oldest_at)}` : '尚无本地记录'}</span><span>{status.data.logs.backfilling ? '历史日志正在分批回补' : '历史范围已扫描'}</span>{status.data.logs.covered_from && status.data.logs.covered_to && <span>已扫描 {time(status.data.logs.covered_from)} 至 {time(status.data.logs.covered_to)}</span>}</div>
      <p className="sync-help">近期日志会反复读取，更新长 SSE 请求的最终状态与用量。统计保持 Cloudflare 全网关口径；本地日志条数只代表已同步且在保留期内的记录。Cloudflare 未采集或已删除的数据无法补回。</p>
    </>}
    {!settings && <p className="sync-caption">{status.data?.logs.backfilling && jobs.includes('logs:head') ? '历史日志回补中 · ' : ''}后台自动同步，页面刷新读取缓存<a href="#settings">网关设置</a></p>}
  </div>;
}
