import { useContext, useState } from 'react';
import { Activity, ArrowRight, Check, ChevronRight, Cloud, Copy, Database, GitBranch, KeyRound, Radio, Terminal, Wallet } from 'lucide-react';
import { useApi, number, compact, money, copy, ToastContext } from '../lib';
import type { Stats, Channel, ApiKey, Model, LogPage, Log, Config } from '../types';
import { Badge, Button, Empty, ErrorBox, Loading, LogDetail, LogTable, PageTitle, Select } from '../components';

function TrafficChart({ stats }: { stats: Stats | null }) {
  if (!stats) return <div className="chart-offline"><div className="chart-grid" aria-hidden="true" /><span className="square-icon"><Activity size={26} /></span><strong>等待网关数据</strong><p>完成 AI Gateway 配置后，查看真实请求趋势。</p><a href="#settings" className="text-link">接入 Cloudflare<ArrowRight size={15} /></a></div>;
  const hourly = stats.range === '24h', step = hourly ? 3600000 : 86400000, count = hourly ? 25 : 8;
  const end = Math.floor(Date.now() / step) * step;
  const bins = Array.from({ length: count }, (_, index) => {
    const date = new Date(end - (count - index - 1) * step);
    const record = stats.series.find(item => Date.parse(item.time) === date.getTime());
    return { date, requests: record?.requests || 0, errors: record?.errors || 0 };
  });
  const max = Math.max(4, ...bins.map(bin => bin.requests));
  const points = bins.map((bin, i) => `${45 + i * 670 / (count - 1)},${195 - bin.requests / max * 160}`).join(' ');
  const errors = bins.map((bin, i) => `${45 + i * 670 / (count - 1)},${195 - bin.errors / max * 160}`).join(' ');
  return <div className="traffic-chart"><svg viewBox="0 0 740 235" role="img" aria-label={`请求量趋势，共 ${stats.summary.requests} 次请求`}>
    <defs><linearGradient id="traffic-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent-text)" stopOpacity="0.2" /><stop offset="100%" stopColor="var(--accent-text)" stopOpacity="0" /></linearGradient></defs>
    {[0, 1, 2, 3, 4].map(i => <g key={i}><line x1="45" x2="715" y1={35 + i * 40} y2={35 + i * 40} stroke="var(--border-subtle)" strokeDasharray="3 5" /><text x="30" y={39 + i * 40} textAnchor="end">{compact(max - max * i / 4)}</text></g>)}
    <polygon points={`45,195 ${points} 715,195`} fill="url(#traffic-fill)" /><polyline points={points} fill="none" stroke="var(--accent-text)" strokeWidth="2.5" strokeLinejoin="round" />
    {stats.summary.successes !== null && <polyline points={errors} fill="none" stroke="var(--warning)" strokeWidth="1.5" strokeDasharray="4 3" />}
    {bins.filter((_, i) => i % (hourly ? 6 : 1) === 0).map(bin => <text key={bin.date.toISOString()} x={45 + bins.indexOf(bin) * 670 / (count - 1)} y="226" textAnchor="middle">{hourly ? bin.date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : `${bin.date.getMonth() + 1}/${bin.date.getDate()}`}</text>)}
  </svg>{stats.summary.requests === 0 && <span className="chart-zero">此时间范围内没有请求</span>}</div>;
}
export function Dashboard() {
  const [range, setRange] = useState('24h'), [selected, setSelected] = useState<Log | null>(null);
  const stats = useApi<Stats>(`/stats?range=${range}`), channels = useApi<Channel[]>('/channels'), models = useApi<Model[]>('/models'), keys = useApi<ApiKey[]>('/keys'), logs = useApi<LogPage>('/logs'), config = useApi<Config>('/config');
  const notify = useContext(ToastContext), base = `${location.origin}/v1`, summary = stats.data?.summary;
  const setupRequired = !!config.data && (!config.data.account_id || !config.data.gateway_id || !config.data.control_token_configured);
  const readyChannels = channels.data?.filter(channel => channel.enabled && channel.configured).length || 0;
  const activeKeys = keys.data?.filter(key => !key.revoked_at && (!key.expires_at || Date.parse(key.expires_at) > Date.now())).length || 0;
  const steps = [
    { label: '连接 AI Gateway', detail: '配置账户与访问令牌', done: !!config.data && !setupRequired, href: '#settings', icon: Cloud },
    { label: '接入模型服务商', detail: `${readyChannels} 个已配置渠道`, done: readyChannels > 0, href: '#channels', icon: Radio },
    { label: '设置模型路由', detail: `${models.data?.length ?? '—'} 个模型`, done: !!models.data?.some(model => model.enabled && model.routes.some(route => route.enabled && channels.data?.some(channel => channel.id === route.channel_id && channel.enabled && channel.configured))), href: '#models', icon: GitBranch },
    { label: '创建应用密钥', detail: `${activeKeys} 个有效密钥`, done: activeKeys > 0, href: '#keys', icon: KeyRound },
  ];
  const metrics = [
    { label: '请求成功率', value: summary?.requests && summary.successes !== null ? `${(summary.successes / summary.requests * 100).toFixed(1)}%` : '—', note: summary?.successes != null ? `${number(summary.successes)} 次成功响应` : '暂无分析数据', icon: Activity },
    { label: '缓存命中率', value: summary?.requests && summary.cache_hits !== null ? `${(summary.cache_hits / summary.requests * 100).toFixed(1)}%` : '—', note: 'Cloudflare 网关缓存', icon: Database },
    { label: '调用费用', value: money(summary?.cost_usd ?? null), note: 'Cloudflare 费用统计', icon: Wallet },
  ];
  return <>
    <PageTitle eyebrow="01 / OVERVIEW" title="运行总览" description="每一次调用，都在掌握之中。" action={<><Select aria-label="统计时间范围" value={range} onChange={setRange}><option value="24h">过去 24 小时</option><option value="7d">过去 7 天</option></Select><a href="#playground" className="btn btn-primary"><Terminal size={17} />发起请求</a></>} />
    <ErrorBox message={channels.error || models.error || keys.error || config.error} />{!setupRequired && [...new Set([stats.error, logs.error].filter(Boolean))].map(message => <ErrorBox key={message} message={message} />)}
    <section className="traffic-workspace surface">
      <div className="traffic-main"><div className="request-volume"><div className="surface-caption"><span className="signal-dot" /> GATEWAY TRAFFIC</div><span className="metric-label">总请求量</span><strong className="volume-number">{summary ? number(summary.requests) : '—'}</strong><span className="muted">{range === '24h' ? '过去 24 小时' : '过去 7 天'} · 上游请求</span><div className="volume-tokens"><span>Token 总量</span><strong>{summary?.input_tokens != null && summary.output_tokens != null ? compact(summary.input_tokens + summary.output_tokens) : '—'}</strong></div><Badge tone={setupRequired ? 'amber' : stats.data ? 'green' : 'neutral'}>{setupRequired ? '等待接入' : stats.data ? '数据已同步' : '等待数据'}</Badge></div>
      <div className="traffic-visual"><div className="surface-heading"><h2>请求趋势</h2><div className="chart-legend"><span><i />请求量</span><span><i className="amber" />错误</span></div></div>{stats.loading && !stats.data ? <Loading /> : <TrafficChart stats={stats.data} />}</div></div>
      <div className="metric-rail">{metrics.map(({ label, value, note, icon: Icon }) => <div key={label}><span className="metric-symbol"><Icon size={19} /></span><div><span>{label}</span><strong>{value}</strong></div><small>{note}</small></div>)}</div>
    </section>
    <div className="overview-secondary">
      <section className="surface model-ranking"><div className="surface-heading"><div><span className="eyebrow">MODEL ACTIVITY</span><h2>模型流量排名</h2></div><a className="text-link" href="#models">模型管理<ArrowRight size={16} /></a></div>
        {stats.data?.models.length ? <div className="rank-list">{stats.data.models.map((model, index) => <div className="rank-row" key={model.model}><span className="rank-number">{String(index + 1).padStart(2, '0')}</span><div><div className="rank-name"><code>{model.model}</code><strong>{number(model.requests)}<small>请求</small></strong></div><div className="rank-track"><i style={{ width: `${Math.min(100, model.requests / Math.max(1, stats.data!.summary.requests) * 100)}%` }} /></div></div></div>)}</div> : <Empty title="还没有模型调用" description="发起第一次请求后，这里将显示各模型的调用分布。" action={<a href="#playground" className="text-link">打开 Playground<ArrowRight size={15} /></a>} />}
      </section>
      <section className="surface readiness"><div className="surface-heading"><div><span className="eyebrow">GET CONNECTED</span><h2>接入检查</h2></div><span className="mono muted">{steps.filter(step => step.done).length} / 4</span></div><div className="readiness-list">{steps.map(({ label, detail, done, href, icon: Icon }, index) => <a href={href} key={label} className={done ? 'done' : ''}><span className="readiness-icon">{done ? <Check size={17} /> : <Icon size={18} />}</span><div><strong>{label}</strong><span>{detail}</span></div><span className="step-number">0{index + 1}</span><ChevronRight size={16} /></a>)}</div></section>
    </div>
    <section className="surface recent-requests"><div className="surface-heading"><div className="inline-heading"><h2>最近请求</h2><Badge>{logs.data?.total ?? '—'} 条</Badge></div><a href="#logs" className="text-link">全部日志<ArrowRight size={16} /></a></div>{logs.data?.data.length ? <LogTable logs={logs.data.data.slice(0, 5)} onSelect={setSelected} /> : logs.loading ? <Loading /> : <Empty title={setupRequired ? '连接网关后查看请求日志' : logs.error ? '暂时无法读取日志' : '等待第一条请求'} description="日志由 Cloudflare AI Gateway 自动采集，按实际配置保留。" />}</section>
    <section className="endpoint-strip"><span className="square-icon"><Terminal size={21} /></span><div><strong>应用接入地址</strong><code>{base}</code></div><Button variant="secondary" onClick={() => copy(base, notify)}><Copy size={16} />复制端点</Button><a href="#settings" className="text-link">接入文档<ArrowRight size={16} /></a></section>
    <p className="page-footnote">统计范围为当前 AI Gateway 的全部请求，包含其他客户端与故障转移尝试。Cloudflare 分析数据可能延迟或采样。</p>
    {selected && <LogDetail log={selected} onClose={() => setSelected(null)} />}
  </>;
}
