import type { Context } from 'hono';
import type { AppEnv, Env } from './types';
import { fetchLogPage } from './cloudflare-observability';
import { ApiError } from './lib/errors';
import { CHANNEL_AVAILABILITY_WINDOW_MS, CHANNEL_AVAILABILITY_BUCKET_MS, CHANNEL_AVAILABILITY_BUCKET_COUNT, type ChannelAvailability, type ChannelAvailabilityResponse } from '../shared/observability';

const MAX_PAGES = 40;
const READ_TIMEOUT_MS = 10_000;
const TIMEOUT_WARNING = 'Cloudflare 日志读取已达到时间上限，当前仅展示已读取的样本。';

export async function getChannelAvailability(env: Env, now = Date.now()): Promise<ChannelAvailabilityResponse> {
  const end = Math.floor(now / 1000) * 1000, start = end - CHANNEL_AVAILABILITY_WINDOW_MS;
  const channels = await env.DB.prepare('SELECT id FROM channels').all<{ id: string }>();
  const byChannel = new Map<string, ChannelAvailability>(channels.results.map(channel => [channel.id, {
    channel_id: channel.id, requests: 0, successes: 0, rate: null,
    buckets: Array.from({ length: CHANNEL_AVAILABILITY_BUCKET_COUNT }, (_, i) => ({
      start: new Date(start + i * CHANNEL_AVAILABILITY_BUCKET_MS).toISOString(), end: new Date(start + (i + 1) * CHANNEL_AVAILABILITY_BUCKET_MS).toISOString(),
      requests: 0, successes: 0, rate: null,
    })),
  }]));

  // Read one global descending stream for every channel. Live pagination can
  // overlap when new requests arrive, so each Cloudflare log ID counts once.
  const seen = new Set<string>();
  let sampledLogs = 0, completedPages = 0;
  let coverage: ChannelAvailabilityResponse['coverage'] = 'partial';
  let warning: string | undefined;
  const controller = new AbortController(), deadline = Date.now() + READ_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (controller.signal.aborted || Date.now() >= deadline) {
        warning = TIMEOUT_WARNING;
        break;
      }
      let result: Awaited<ReturnType<typeof fetchLogPage>>;
      try {
        result = await fetchLogPage(env, page, { signal: controller.signal });
      } catch (error) {
        // A failed first read must remain an error, never an empty report.
        if (!completedPages) {
          if (controller.signal.aborted) throw new ApiError(504, 'cloudflare_timeout', 'Cloudflare 日志读取超时');
          throw error;
        }
        warning = controller.signal.aborted ? TIMEOUT_WARNING : '读取后续 Cloudflare 日志失败，当前仅展示已读取的样本。';
        break;
      }
      completedPages++;
      let reachedStart = false, newLogs = 0;
      for (const log of result.logs) {
        const time = Date.parse(log.created_at);
        if (time < start) reachedStart = true;
        if (seen.has(log.id)) continue;
        seen.add(log.id);
        newLogs++;
        if (time < start || time >= end || typeof log.success !== 'boolean' || log.cached !== 0) continue;
        // Stable IDs survive channel renames and distinguish shared providers.
        const channel = log.channel_id ? byChannel.get(log.channel_id) : undefined;
        const bucket = channel?.buckets[Math.floor((time - start) / CHANNEL_AVAILABILITY_BUCKET_MS)];
        if (!channel || !bucket) continue;
        sampledLogs++;
        channel.requests++;
        bucket.requests++;
        if (log.success) { channel.successes++; bucket.successes++; }
      }
      if (reachedStart || !result.has_more) {
        coverage = 'complete';
        break;
      }
      if (!newLogs) {
        warning = 'Cloudflare 日志分页未返回新记录，当前仅展示已读取的样本。';
        break;
      }
      if (page === MAX_PAGES) warning = '本次已达到 Cloudflare 日志分页上限，当前仅展示已读取的样本。';
    }
  } finally {
    clearTimeout(timeout);
  }
  for (const channel of byChannel.values()) {
    channel.rate = channel.requests ? channel.successes / channel.requests : null;
    for (const bucket of channel.buckets) bucket.rate = bucket.requests ? bucket.successes / bucket.requests : null;
  }
  return {
    data: [...byChannel.values()], window_start: new Date(start).toISOString(), window_end: new Date(end).toISOString(),
    source: 'cloudflare', coverage, sampled_logs: sampledLogs, fetched_at: new Date().toISOString(),
    ...(warning ? { warning } : {}),
  };
}

export async function channelAvailability(c: Context<AppEnv>) {
  return c.json(await getChannelAvailability(c.env));
}
