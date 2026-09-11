import { CHANNEL_AVAILABILITY_BUCKET_COUNT, type ChannelAvailability as Availability, type ChannelAvailabilityResponse } from '../shared/observability';
import { time } from './lib';

const percent = (rate: number | null | undefined) => rate == null ? '—' : `${Math.floor(rate * 1000) / 10}%`;
const tone = (rate: number | null | undefined) => rate == null ? 'empty' : rate === 1 ? 'healthy' : rate === 0 ? 'failed' : 'degraded';

export function ChannelAvailability({ report, data, loading, error }: {
  report?: Availability; data: ChannelAvailabilityResponse | null; loading: boolean; error: string;
}) {
  const jobs = data?.jobs || (data ? [data.sync] : []);
  const failedJob = jobs.find(job => job.state === 'error');
  const delayedJob = jobs.find(job => job.job !== 'logs:history' && job.last_success_at && job.stale);
  const note = error ? '读取失败' : !data ? loading ? '加载中' : '暂无数据'
    : failedJob ? '同步异常' : !data.sync.last_success_at ? '待同步'
      : delayedJob ? '同步延迟' : data.backfilling ? '回补中' : !report?.requests ? '无有效记录' : '';
  const summary = `近 1 小时已同步请求成功率：${percent(report?.rate)}。${report?.successes || 0} 次成功 / ${report?.requests || 0} 次请求；不含缓存命中。每块 2 分钟，从左到右由旧到新。`;
  const syncNote = error || failedJob?.last_error || (delayedJob?.last_success_at ? `最近同步：${time(delayedJob.last_success_at)}` : data?.sync.last_success_at ? `最近同步：${time(data.sync.last_success_at)}` : '等待后台同步日志');
  const buckets = report?.buckets || Array.from({ length: CHANNEL_AVAILABILITY_BUCKET_COUNT }, () => null);
  return <div className="channel-availability">
    <div className="availability-heading"><span title={summary}>1h 可用率</span><span className="availability-value">{note && <small title={syncNote}>{note}</small>}<strong className={`is-${tone(report?.rate)}`}>{percent(report?.rate)}</strong></span></div>
    <div className="availability-blocks" style={{ gridTemplateColumns: `repeat(${CHANNEL_AVAILABILITY_BUCKET_COUNT}, minmax(0, 1fr))` }} role="group" aria-label={summary}>
      {buckets.map((bucket, index) => {
        const label = bucket ? `${time(bucket.start)} – ${time(bucket.end)}：${bucket.requests ? `${percent(bucket.rate)}，${bucket.successes} / ${bucket.requests} 次成功` : '无有效请求记录'}` : '暂无可用率数据';
        return <span key={index} className={`availability-block is-${tone(bucket?.rate)}`} role="img" aria-label={label} title={label} />;
      })}
    </div>
  </div>;
}
