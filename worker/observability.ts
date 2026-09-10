import type { Context } from 'hono';
import type { AppEnv, Env } from './types';
import { cfApi, cfGraphql, accountId, gatewayId, gatewayPath } from './cloudflare';
import { ApiError } from './lib/errors';
import { sha256 } from './lib/crypto';

interface GatewayLog {
  id: string; created_at: string; duration: number; model: string; provider: string; success: boolean;
  tokens_in: number | null; tokens_out: number | null; cached: boolean; cost?: number; status_code?: number;
  metadata?: string | Record<string, unknown>; response_content_type?: string; request_type?: string; step?: number;
}
export function normalizeLog(log: GatewayLog) {
  let metadata: Record<string, unknown> = {};
  try { metadata = typeof log.metadata === 'string' ? JSON.parse(log.metadata) : log.metadata || {}; } catch { /* External logs may carry opaque metadata. */ }
  const text = (key: string) => typeof metadata?.[key] === 'string' ? metadata[key] as string : null;
  return {
    id: log.id, request_id: text('request_id'), model: text('model_alias') || log.model,
    channel_name: text('channel_name') || log.provider, key_name: text('key_name') || '外部调用',
    status: log.status_code ?? null, success: log.success, latency_ms: log.duration,
    input_tokens: log.tokens_in ?? null, output_tokens: log.tokens_out ?? null, cost_usd: log.cost ?? null,
    cached: +log.cached, stream: log.response_content_type?.includes('text/event-stream') ? 1 : 0,
    attempts: Number(text('attempt')) || null, error_code: null, created_at: log.created_at,
    upstream_model: log.model, provider: log.provider, source: 'cloudflare',
  };
}
export async function logs(c: Context<AppEnv>) {
  const page = Math.max(1, Math.min(10000, Math.floor(Number(c.req.query('page')) || 1)));
  const params = new URLSearchParams({ page: String(page), per_page: '25', order_by: 'created_at', order_by_direction: 'desc', meta_info: 'true' });
  // Cloudflare's public REST API also accepts these documented scalar filters.
  if (c.req.query('status') === 'success') params.set('success', 'true');
  if (c.req.query('status') === 'error') params.set('success', 'false');
  if (c.req.query('model')) params.set('model', c.req.query('model')!);
  if (c.req.query('search')) params.set('search', c.req.query('search')!.slice(0, 160));
  const response = await cfApi<GatewayLog[]>(c.env, `${gatewayPath(c.env)}/logs?${params}`);
  if (!Array.isArray(response.result)) throw new ApiError(502, 'cloudflare_invalid_response', 'Cloudflare 日志列表格式异常');
  return c.json({ data: response.result.map(normalizeLog), total: response.result_info?.total_count ?? null,
    page, page_size: 25, has_more: response.result_info?.total_pages != null ? page < response.result_info.total_pages : response.result.length === 25,
    source: 'cloudflare', gateway_id: gatewayId(c.env),
  });
}
export async function logDetail(c: Context<AppEnv>) {
  const response = await cfApi<GatewayLog>(c.env, `${gatewayPath(c.env)}/logs/${encodeURIComponent(c.req.param('id')!)}`);
  return c.json(normalizeLog(response.result));
}

type Metrics = { tokensIn?: number; tokensOut?: number; cost?: number; erroredRequests?: number; cachedRequests?: number };
type Group = { count: number; sum?: Metrics; dimensions?: { ts?: string; model?: string } };
interface Analytics { viewer: { accounts: { summary: Group[]; series: Group[]; models: Group[] }[] } }
interface Schema { fields: { name: string }[] }
async function metricFields(env: Env) {
  // Query Cloudflare's live schema instead of assuming every account exposes the same metrics.
  const key = `cf:analytics-schema:${accountId(env)}:${(await sha256(env.CF_API_TOKEN || '')).slice(0, 16)}`;
  const saved = await env.KV.get<string[]>(key, 'json');
  if (saved) return saved;
  const schema = await cfGraphql<{ sum: Schema | null }>(env, '{ sum: __type(name: "AccountAiGatewayRequestsAdaptiveGroupsSum") { fields { name } } }');
  const supported = new Set(schema.sum?.fields.map(f => f.name) || []);
  const fields = ['tokensIn', 'tokensOut', 'cost', 'erroredRequests', 'cachedRequests'].filter(name => supported.has(name));
  await env.KV.put(key, JSON.stringify(fields), { expirationTtl: 86400 });
  return fields;
}
export async function stats(c: Context<AppEnv>) {
  const range = c.req.query('range') === '7d' ? '7d' : '24h';
  const end = new Date(), start = new Date(end.getTime() - (range === '7d' ? 7 : 1) * 86400000);
  start.setUTCMinutes(0, 0, 0); end.setUTCMinutes(0, 0, 0);
  const fields = await metricFields(c.env);
  const selection = fields.length ? `sum { ${fields.join(' ')} }` : '';
  const filter = `filter: { gateway: ${JSON.stringify(gatewayId(c.env))}, datetimeHour_geq: ${JSON.stringify(start.toISOString())}, datetimeHour_leq: ${JSON.stringify(end.toISOString())} }`;
  const data = await cfGraphql<Analytics>(c.env, `query {
    viewer { accounts(filter: { accountTag: ${JSON.stringify(accountId(c.env))} }) {
      summary: aiGatewayRequestsAdaptiveGroups(limit: 1, ${filter}) { count ${selection} }
      series: aiGatewayRequestsAdaptiveGroups(limit: 200, ${filter}, orderBy: [datetimeHour_ASC]) { count ${selection} dimensions { ts: datetimeHour } }
      models: aiGatewayRequestsAdaptiveGroups(limit: 6, ${filter}, orderBy: [count_DESC]) { count dimensions { model } }
    } }
  }`);
  const account = data.viewer?.accounts?.[0];
  if (!account || !Array.isArray(account.summary) || !Array.isArray(account.series) || !Array.isArray(account.models)) throw new ApiError(502, 'cloudflare_analytics_error', 'Cloudflare 未返回该账户的网关统计数据');
  const group = account.summary[0], requests = group?.count ?? 0;
  const metric = (field: keyof Metrics) => !fields.includes(field) ? null : group ? group.sum?.[field] ?? null : 0;
  const errors = metric('erroredRequests');
  const series = new Map<string, { time: string; requests: number; errors: number | null }>();
  for (const row of account.series) {
    const date = new Date(row.dimensions?.ts || '');
    if (!Number.isFinite(date.getTime())) throw new ApiError(502, 'cloudflare_analytics_error', 'Cloudflare 返回了无效统计时间');
    if (range === '7d') date.setUTCHours(0, 0, 0, 0);
    const time = date.toISOString(), current = series.get(time) || { time, requests: 0, errors: fields.includes('erroredRequests') ? 0 : null };
    current.requests += row.count;
    if (current.errors !== null) current.errors += row.sum?.erroredRequests ?? 0;
    series.set(time, current);
  }
  return c.json({ source: 'cloudflare', scope: 'gateway', gateway_id: gatewayId(c.env), range,
    summary: { requests, successes: errors === null ? null : Math.max(0, requests - errors), input_tokens: metric('tokensIn'), output_tokens: metric('tokensOut'), cost_usd: metric('cost'), cache_hits: metric('cachedRequests') },
    series: [...series.values()].sort((a, b) => a.time.localeCompare(b.time)), models: account.models.map(row => ({ model: row.dimensions?.model || 'unknown', requests: row.count })),
  });
}
