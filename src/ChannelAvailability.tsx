import { CHANNEL_AVAILABILITY_BUCKET_COUNT, type ChannelAvailability as Availability, type ChannelAvailabilityResponse } from '../shared/observability';
import { time } from './lib';

const percent = (rate: number | null | undefined) => rate == null ? '—' : `${Math.floor(rate * 1000) / 10}%`;
const tone = (rate: number | null | undefined) => rate == null ? 'empty' : rate === 1 ? 'healthy' : rate === 0 ? 'failed' : 'degraded';

export function ChannelAvailability({ report, data, loading, error }: {
  report?: Availability; data: ChannelAvailabilityResponse | null; loading: boolean; error: string;
}) {
  const current = !loading && !error ? report : undefined;
  const note = loading ? '读取中' : error ? '读取失败' : !data ? '暂无数据'
    : data.coverage === 'partial' ? '样本不完整' : !current?.requests ? '无有效记录' : '';
  const readNote = loading ? '正在从 Cloudflare 读取本次样本' : error || (data
    ? `${data.coverage === 'partial' ? `本次样本不完整，仅表示已读取请求的成功率。${data.warning || ''}` : '已读取本次时间范围内 Cloudflare 可返回的日志。'}有效样本 ${data.sampled_logs} 条；读取时间：${time(data.fetched_at)}`
    : '尚未读取可用率数据');
  const summary = current
    ? `近 1 小时请求样本成功率：${percent(current.rate)}。${current.successes} 次成功 / ${current.requests} 次请求；不含缓存命中。每块 2 分钟，从左到右由旧到新。${readNote}`
    : readNote;
  const buckets = current?.buckets || Array.from({ length: CHANNEL_AVAILABILITY_BUCKET_COUNT }, () => null);
  return <div className="channel-availability">
    <div className="availability-heading"><span title={summary}>1h 可用率</span><span className="availability-value">{note && <small title={readNote}>{note}</small>}<strong className={`is-${tone(current?.rate)}`}>{percent(current?.rate)}</strong></span></div>
    <div className="availability-blocks" style={{ gridTemplateColumns: `repeat(${CHANNEL_AVAILABILITY_BUCKET_COUNT}, minmax(0, 1fr))` }} role="group" aria-label={summary}>
      {buckets.map((bucket, index) => {
        const label = bucket ? `${time(bucket.start)} – ${time(bucket.end)}：${bucket.requests ? `${percent(bucket.rate)}，${bucket.successes} / ${bucket.requests} 次成功` : '本次样本中无有效请求记录'}${data?.coverage === 'partial' ? '；本次样本不完整' : ''}` : readNote;
        return <span key={index} className={`availability-block is-${tone(bucket?.rate)}`} role="img" aria-label={label} title={label} />;
      })}
    </div>
  </div>;
}
