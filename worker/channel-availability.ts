import type { Context } from 'hono';
import type { AppEnv, Env } from './types';
import { jobStatus, observabilityScope, type LogCursor, type SyncRow } from './observability-store';
import { CHANNEL_AVAILABILITY_WINDOW_MS, CHANNEL_AVAILABILITY_BUCKET_MS, CHANNEL_AVAILABILITY_BUCKET_COUNT, type ChannelAvailability, type ChannelAvailabilityResponse } from '../shared/observability';

interface BucketRow { channel_id: string; bucket: number; requests: number; successes: number }

export async function getChannelAvailability(env: Env, now = Date.now()): Promise<ChannelAvailabilityResponse> {
  const end = Math.floor(now / 1000) * 1000, start = end - CHANNEL_AVAILABILITY_WINDOW_MS;
  const window_start = new Date(start).toISOString(), window_end = new Date(end).toISOString();
  const scope = observabilityScope(env);
  const [channels, rows, jobs] = await Promise.all([
    env.DB.prepare('SELECT id FROM channels').all<{ id: string }>(),
    // One indexed one-hour scan for every channel. Never infer identity from names:
    // renamed channels and channels sharing a provider must remain separate.
    env.DB.prepare(`SELECT json_extract(payload, '$.channel_id') AS channel_id,
      CAST((unixepoch(created_at) - ?) / ? AS INTEGER) AS bucket,
      COUNT(*) AS requests, SUM(CASE WHEN json_extract(payload, '$.success') = 1 THEN 1 ELSE 0 END) AS successes
      FROM observability_logs
      WHERE scope = ? AND created_at >= ? AND created_at < ?
        AND json_type(payload, '$.success') IN ('true', 'false')
        AND COALESCE(json_extract(payload, '$.cached'), 0) = 0
        AND json_extract(payload, '$.channel_id') IN (SELECT id FROM channels)
      GROUP BY channel_id, bucket`).bind(start / 1000, CHANNEL_AVAILABILITY_BUCKET_MS / 1000, scope, window_start, window_end).all<BucketRow>(),
    env.DB.prepare("SELECT * FROM observability_jobs WHERE scope = ? AND job IN ('logs:head', 'logs:repair', 'logs:history')").bind(scope).all<SyncRow>(),
  ]);
  const byChannel = new Map<string, ChannelAvailability>(channels.results.map(channel => [channel.id, {
    channel_id: channel.id, requests: 0, successes: 0, rate: null,
    buckets: Array.from({ length: CHANNEL_AVAILABILITY_BUCKET_COUNT }, (_, i) => ({
      start: new Date(start + i * CHANNEL_AVAILABILITY_BUCKET_MS).toISOString(), end: new Date(start + (i + 1) * CHANNEL_AVAILABILITY_BUCKET_MS).toISOString(),
      requests: 0, successes: 0, rate: null,
    })),
  }]));
  for (const row of rows.results) {
    const channel = byChannel.get(row.channel_id), bucket = channel?.buckets[row.bucket];
    if (!channel || !bucket) continue;
    Object.assign(bucket, { requests: row.requests, successes: row.successes, rate: row.successes / row.requests });
    channel.requests += row.requests;
    channel.successes += row.successes;
  }
  for (const channel of byChannel.values()) channel.rate = channel.requests ? channel.successes / channel.requests : null;
  const head = jobs.results.find(row => row.job === 'logs:head');
  const repair = jobs.results.find(row => row.job === 'logs:repair');
  const history = jobs.results.find(row => row.job === 'logs:history');
  const coverage: LogCursor = history?.cursor ? JSON.parse(history.cursor) : {};
  const unfinished = jobs.results.some(row => row.job !== 'logs:history' && row.cursor && (JSON.parse(row.cursor) as LogCursor).window);
  const result: ChannelAvailabilityResponse = {
    data: [...byChannel.values()], window_start, window_end, storage: 'd1', source: 'cloudflare',
    sync: jobStatus('logs:head', head),
    jobs: [jobStatus('logs:head', head), jobStatus('logs:repair', repair), jobStatus('logs:history', history)],
    backfilling: unfinished || !repair?.last_success_at || !coverage.covered_from || coverage.covered_from > window_start
      || !coverage.covered_to || Date.parse(coverage.covered_to) < end - 10 * 60000,
  };
  return result;
}

export async function channelAvailability(c: Context<AppEnv>) {
  return c.json(await getChannelAvailability(c.env));
}
