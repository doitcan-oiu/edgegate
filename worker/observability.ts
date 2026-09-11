import type { Context } from 'hono';
import type { AppEnv } from './types';
import { gatewayId } from './cloudflare';
import { ApiError } from './lib/errors';
import type { UpstreamErrorTrace } from '../shared/gateway-settings';
import { ERROR_RETENTION_DAYS } from './upstream-errors';
import { getObservabilitySettings, getSyncStatus, observabilityScope, retentionCutoff } from './observability-store';
import type { fetchStats, normalizeLog } from './cloudflare-observability';

export { normalizeLog } from './cloudflare-observability';
type CachedLog = ReturnType<typeof normalizeLog>;

export async function logs(c: Context<AppEnv>) {
  const page = Math.max(1, Math.min(10000, Math.floor(Number(c.req.query('page')) || 1)));
  const scope = observabilityScope(c.env), settings = await getObservabilitySettings(c.env);
  const conditions = ['scope = ?', 'created_at >= ?'];
  const values: (string | number)[] = [scope, retentionCutoff(settings.log_retention_days)];
  if (['success', 'error'].includes(c.req.query('status') || '')) { conditions.push('success = ?'); values.push(c.req.query('status') === 'success' ? 1 : 0); }
  if (c.req.query('model')) { conditions.push('upstream_model = ?'); values.push(c.req.query('model')!.slice(0, 160)); }
  if (c.req.query('search')) {
    // Literal substring matching, so '%' and '_' are not accidentally SQL wildcards.
    conditions.push("(instr(lower(id), lower(?)) > 0 OR instr(lower(upstream_model), lower(?)) > 0 OR instr(lower(json_extract(payload, '$.channel_name')), lower(?)) > 0)");
    values.push(...Array(3).fill(c.req.query('search')!.slice(0, 160)));
  }
  const where = conditions.join(' AND ');
  const [rows, count, sync] = await Promise.all([
    c.env.DB.prepare(`SELECT payload FROM observability_logs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT 25 OFFSET ?`).bind(...values, (page - 1) * 25).all<{ payload: string }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM observability_logs WHERE ${where}`).bind(...values).first<{ total: number }>(),
    getSyncStatus(c.env, scope, 'logs:head'),
  ]);
  const total = count?.total || 0;
  return c.json({ data: rows.results.map(row => JSON.parse(row.payload) as CachedLog), total, page, page_size: 25, has_more: page * 25 < total,
    source: 'cloudflare', storage: 'd1', gateway_id: gatewayId(c.env), retention_days: settings.log_retention_days, sync });
}

export async function logDetail(c: Context<AppEnv>) {
  const settings = await getObservabilitySettings(c.env);
  const row = await c.env.DB.prepare('SELECT payload, synced_at FROM observability_logs WHERE scope = ? AND id = ? AND created_at >= ?')
    .bind(observabilityScope(c.env), c.req.param('id'), retentionCutoff(settings.log_retention_days)).first<{ payload: string; synced_at: string }>();
  if (!row) throw new ApiError(404, 'log_not_synced', '该日志尚未同步或已超过本地保留期；原始错误仍可通过请求追踪查询');
  const detail = JSON.parse(row.payload) as CachedLog;
  const cutoff = new Date(Date.now() - ERROR_RETENTION_DAYS * 86400000).toISOString();
  const byLog = await c.env.DB.prepare('SELECT * FROM upstream_error_traces WHERE cf_log_id = ? AND created_at >= ? LIMIT 1').bind(detail.id, cutoff).first<UpstreamErrorTrace>();
  const error = byLog || (detail.request_id && detail.attempts ? await c.env.DB.prepare('SELECT * FROM upstream_error_traces WHERE request_id = ? AND attempt = ? AND created_at >= ?').bind(detail.request_id, detail.attempts, cutoff).first<UpstreamErrorTrace>() : null);
  return c.json({ ...detail, storage: 'd1', synced_at: row.synced_at, upstream_error: error });
}

export async function stats(c: Context<AppEnv>) {
  const range = c.req.query('range') === '7d' ? '7d' : '24h', scope = observabilityScope(c.env);
  const [saved, sync] = await Promise.all([
    c.env.DB.prepare('SELECT payload, updated_at FROM observability_snapshots WHERE scope = ? AND range = ?').bind(scope, range).first<{ payload: string; updated_at: string }>(),
    getSyncStatus(c.env, scope, range === '7d' ? 'stats:7d' : 'stats:24h'),
  ]);
  const snapshot = saved ? JSON.parse(saved.payload) as Awaited<ReturnType<typeof fetchStats>> : {
    source: 'cloudflare', scope: 'gateway', gateway_id: gatewayId(c.env), range, summary: null, series: [], models: [], window_start: null, window_end: null,
  };
  return c.json({ ...snapshot, storage: 'd1', synced_at: saved?.updated_at || null, sync });
}
