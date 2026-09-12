import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChannelAvailability } from '../worker/channel-availability';
import { fetchLogPage } from '../worker/cloudflare-observability';
import type { Env } from '../worker/types';

vi.mock('../worker/cloudflare-observability', () => ({ fetchLogPage: vi.fn() }));

type Log = Awaited<ReturnType<typeof fetchLogPage>>['logs'][number];
const now = Date.parse('2026-09-13T08:01:03.789Z');
const end = Math.floor(now / 1000) * 1000, start = end - 60 * 60 * 1000;
function log(id: string, time = end - 1000, overrides: Partial<Log> = {}): Log {
  return {
    id, request_id: 'shared-request', model: 'model', channel_id: 'channel-a', channel_name: 'Old name', key_name: 'key',
    status: 200, success: true, latency_ms: 10, input_tokens: 1, output_tokens: 1, cost_usd: null,
    cached: 0, stream: 0, attempts: 1, error_code: null, created_at: new Date(time).toISOString(),
    upstream_model: 'upstream', provider: 'same-provider', source: 'cloudflare', ...overrides,
  };
}
function env() {
  const all = vi.fn(async () => ({ results: [{ id: 'channel-a' }, { id: 'channel-b' }, { id: 'channel-empty' }] }));
  const prepare = vi.fn(() => ({ all }));
  return { env: { DB: { prepare } } as unknown as Env, prepare };
}
function page(logs: Log[], has_more = false) { return { logs, total: null, has_more }; }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.resetAllMocks(); });

describe('live Cloudflare channel availability', () => {
  it('uses stable channel IDs, exact rolling buckets, and valid uncached samples', async () => {
    const logs = [
      log('start', start), log('failure', start + 60_000, { success: false }),
      log('next-bucket', start + 120_000, { channel_name: 'Renamed channel' }),
      log('other-channel', end - 1, { channel_id: 'channel-b', channel_name: 'Renamed channel' }),
      log('at-end', end), log('old', start - 1), log('cached', end - 1000, { cached: 1 }),
      log('no-success', end - 1000, { success: undefined as never }),
      log('string-success', end - 1000, { success: 'true' as never }),
      log('no-channel', end - 1000, { channel_id: null }),
      log('unknown-channel', end - 1000, { channel_id: 'deleted-channel' }),
    ].sort((a, b) => b.created_at.localeCompare(a.created_at));
    vi.mocked(fetchLogPage).mockResolvedValue(page(logs, true));
    const state = env(), result = await getChannelAvailability(state.env, now);
    expect(result).toMatchObject({ window_start: new Date(start).toISOString(), window_end: new Date(end).toISOString(), source: 'cloudflare', coverage: 'complete', sampled_logs: 4, fetched_at: new Date(now).toISOString() });
    expect(result).not.toHaveProperty('storage');
    expect(result).not.toHaveProperty('sync');
    expect(result).not.toHaveProperty('warning');
    const [a, b, empty] = result.data;
    expect(a).toMatchObject({ channel_id: 'channel-a', requests: 3, successes: 2, rate: 2 / 3 });
    expect(a.buckets).toHaveLength(30);
    expect(a.buckets[0]).toEqual({ start: new Date(start).toISOString(), end: new Date(start + 120_000).toISOString(), requests: 2, successes: 1, rate: 0.5 });
    expect(a.buckets[1]).toMatchObject({ requests: 1, successes: 1, rate: 1 });
    expect(b).toMatchObject({ channel_id: 'channel-b', requests: 1, successes: 1, rate: 1 });
    expect(b.buckets[29]).toMatchObject({ end: new Date(end).toISOString(), requests: 1 });
    expect(empty).toMatchObject({ channel_id: 'channel-empty', requests: 0, successes: 0, rate: null });
    expect(empty.buckets.every(bucket => bucket.requests === 0 && bucket.rate === null)).toBe(true);
    expect(fetchLogPage).toHaveBeenCalledOnce();
    expect(state.prepare).toHaveBeenCalledExactlyOnceWith('SELECT id FROM channels');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('paginates globally, deduplicates overlapping IDs, and stops at the hour boundary', async () => {
    vi.mocked(fetchLogPage)
      .mockResolvedValueOnce(page([log('a'), log('b', end - 60_000, { success: false })], true))
      .mockResolvedValueOnce(page([log('b', end - 60_000, { success: false }), log('c', start), log('old', start - 1)], true));
    const state = env(), result = await getChannelAvailability(state.env, now);
    expect(result).toMatchObject({ coverage: 'complete', sampled_logs: 3 });
    expect(result.data[0]).toMatchObject({ requests: 3, successes: 2, rate: 2 / 3 });
    expect(fetchLogPage).toHaveBeenCalledTimes(2);
    expect(fetchLogPage).toHaveBeenNthCalledWith(1, state.env, 1, { signal: expect.any(AbortSignal) });
    expect(fetchLogPage).toHaveBeenNthCalledWith(2, state.env, 2, { signal: expect.any(AbortSignal) });
  });

  it('returns all channels with empty buckets only after a successful empty CF response', async () => {
    vi.mocked(fetchLogPage).mockResolvedValue(page([]));
    const result = await getChannelAvailability(env().env, now);
    expect(result).toMatchObject({ coverage: 'complete', sampled_logs: 0 });
    expect(result.data).toHaveLength(3);
    for (const channel of result.data) {
      expect(channel.rate).toBeNull();
      expect(channel.buckets).toHaveLength(30);
      expect(channel.buckets.every(bucket => bucket.rate === null)).toBe(true);
    }
  });

  it('reports partial coverage on the pagination cap', async () => {
    vi.mocked(fetchLogPage).mockImplementation(async (_env, currentPage) => page([log(String(currentPage))], true));
    const result = await getChannelAvailability(env().env, now);
    expect(fetchLogPage).toHaveBeenCalledTimes(40);
    expect(result).toMatchObject({ coverage: 'partial', sampled_logs: 40, warning: expect.stringContaining('分页上限') });
  });

  it('stops repeated pages without counting duplicate requests or claiming completion', async () => {
    vi.mocked(fetchLogPage).mockResolvedValue(page([log('a')], true));
    const result = await getChannelAvailability(env().env, now);
    expect(fetchLogPage).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ coverage: 'partial', sampled_logs: 1, warning: expect.stringContaining('未返回新记录') });
  });

  it('does not claim completeness when an empty page still advertises more logs', async () => {
    vi.mocked(fetchLogPage).mockResolvedValue(page([], true));
    const result = await getChannelAvailability(env().env, now);
    expect(result).toMatchObject({ coverage: 'partial', sampled_logs: 0, warning: expect.any(String) });
    expect(fetchLogPage).toHaveBeenCalledOnce();
  });

  it('preserves successful pages as partial if a later Cloudflare request fails', async () => {
    vi.mocked(fetchLogPage).mockResolvedValueOnce(page([log('a')], true)).mockRejectedValueOnce(new Error('Cloudflare 503'));
    const result = await getChannelAvailability(env().env, now);
    expect(result).toMatchObject({ coverage: 'partial', sampled_logs: 1, warning: expect.stringContaining('失败') });
    expect(result.data[0].requests).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates an initial Cloudflare error instead of fabricating an empty report', async () => {
    const failure = new Error('Cloudflare 503');
    vi.mocked(fetchLogPage).mockRejectedValue(failure);
    await expect(getChannelAvailability(env().env, now)).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an in-flight follow-up page at the total time budget and marks data partial', async () => {
    vi.mocked(fetchLogPage).mockResolvedValueOnce(page([log('a')], true))
      .mockImplementation((_env, _page, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
    const pending = getChannelAvailability(env().env, now);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result).toMatchObject({ coverage: 'partial', sampled_logs: 1, warning: expect.stringContaining('时间上限') });
    expect(fetchLogPage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces an initial timeout as an error, without a no-sample success response', async () => {
    vi.mocked(fetchLogPage).mockImplementation((_env, _page, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const rejection = expect(getChannelAvailability(env().env, now)).rejects.toMatchObject({ status: 504, code: 'cloudflare_timeout' });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads Cloudflare again on every request', async () => {
    vi.mocked(fetchLogPage).mockResolvedValueOnce(page([log('a')])).mockResolvedValueOnce(page([log('b', end - 1000, { success: false })]));
    const state = env();
    expect((await getChannelAvailability(state.env, now)).data[0].rate).toBe(1);
    expect((await getChannelAvailability(state.env, now)).data[0].rate).toBe(0);
    expect(fetchLogPage).toHaveBeenCalledTimes(2);
  });
});
