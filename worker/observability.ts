import type { Context } from 'hono';
import type { AppEnv } from './types';
import { cfApi, gatewayId, gatewayPath } from './cloudflare';
import { ApiError } from './lib/errors';
import type { UpstreamErrorTrace } from '../shared/gateway-settings';
import { ERROR_RETENTION_DAYS } from './upstream-errors';
import { fetchLogPage, fetchStats, normalizeLog, type GatewayLog } from './cloudflare-observability';

export async function logs(c: Context<AppEnv>) {
  const page = Math.max(1, Math.min(10000, Math.floor(Number(c.req.query('page')) || 1)));
  const result = await fetchLogPage(c.env, page, { perPage: 25,
    status: c.req.query('status'), model: c.req.query('model'), search: c.req.query('search') });
  return c.json({ data: result.logs, total: result.total, page, page_size: 25, has_more: result.has_more,
    source: 'cloudflare', gateway_id: gatewayId(c.env) });
}

export async function logDetail(c: Context<AppEnv>) {
  const response = await cfApi<GatewayLog>(c.env, `${gatewayPath(c.env)}/logs/${encodeURIComponent(c.req.param('id')!)}`);
  if (!response.result || typeof response.result.id !== 'string' || !response.result.id || !Number.isFinite(Date.parse(response.result.created_at))) {
    throw new ApiError(502, 'cloudflare_invalid_response', 'Cloudflare 日志详情格式异常');
  }
  // Only expose metadata. Full request/response bodies and headers stay in Cloudflare.
  const detail = normalizeLog(response.result);
  const cutoff = new Date(Date.now() - ERROR_RETENTION_DAYS * 86400000).toISOString();
  const byLog = await c.env.DB.prepare('SELECT * FROM upstream_error_traces WHERE cf_log_id = ? AND created_at >= ? LIMIT 1').bind(detail.id, cutoff).first<UpstreamErrorTrace>();
  const error = byLog || (detail.request_id && detail.attempts ? await c.env.DB.prepare('SELECT * FROM upstream_error_traces WHERE request_id = ? AND attempt = ? AND created_at >= ?').bind(detail.request_id, detail.attempts, cutoff).first<UpstreamErrorTrace>() : null);
  return c.json({ ...detail, upstream_error: error });
}

export async function stats(c: Context<AppEnv>) {
  return c.json(await fetchStats(c.env, c.req.query('range') === '7d' ? '7d' : '24h'));
}
