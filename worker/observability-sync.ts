import type { Env } from './types';
import { fetchLogPage, fetchStats } from './cloudflare-observability';
import { ApiError } from './lib/errors';
import { sha256 } from './lib/crypto';
import { SYNC_INTERVALS, type SyncJobName } from '../shared/observability';
import { DAY, JOBS, ensureSyncJobs, getObservabilitySettings, observabilityScope, retentionCutoff, type LogCursor, type SyncRow } from './observability-store';

const LEASE_MS = 5 * 60000;
const RUN_BUDGET_MS = 45000;
const PAGE_BUDGET: Record<string, number> = { 'logs:head': 4, 'logs:repair': 3, 'logs:history': 4 };
const iso = (ms: number) => new Date(ms).toISOString();

async function claimJob(env: Env, scope: string, job: SyncJobName) {
  const now = Date.now(), owner = crypto.randomUUID();
  return env.DB.prepare(`UPDATE observability_jobs SET lease_owner = ?, lease_until = ?, last_attempt_at = ?
    WHERE scope = ? AND job = ? AND lease_until <= ? AND (next_run_at <= ? OR requested_seq > handled_seq) RETURNING *`)
    .bind(owner, now + LEASE_MS, iso(now), scope, job, now, now).first<SyncRow>();
}

function leaseGuard(row: SyncRow) {
  return { sql: 'EXISTS (SELECT 1 FROM observability_jobs WHERE scope = ? AND job = ? AND lease_owner = ? AND lease_until > ?)',
    values: [row.scope, row.job, row.lease_owner!, Date.now()] };
}

function nextWindow(cursor: LogCursor, job: SyncJobName, cutoff: string, now: number): LogCursor['window'] {
  if (cursor.window) return cursor.window;
  if (job === 'logs:head') return { start: iso(now - 5 * 60000), end: iso(now), page: 1 };
  if (job === 'logs:repair') return { start: iso(now - 2 * 3600000), end: iso(now - 5 * 60000), page: 1 };
  const target = iso(now - 5 * 60000), span = 6 * 3600000;
  cursor.covered_from ||= target;
  cursor.covered_to ||= target;
  cursor.last_audit_at ??= now;
  if (cursor.covered_from > cutoff) {
    return { start: iso(Math.max(Date.parse(cutoff), Date.parse(cursor.covered_from) - span)), end: cursor.covered_from, page: 1, kind: 'backfill' };
  }
  if (cursor.covered_to < target) {
    return { start: cursor.covered_to, end: iso(Math.min(Date.parse(target), Date.parse(cursor.covered_to) + span)), page: 1, kind: 'forward' };
  }
  // Lower-frequency re-read also repairs unusually late arrivals outside the SSE lookback.
  if (cursor.audit_to || now - cursor.last_audit_at >= DAY) {
    const end = cursor.audit_to || target;
    return { start: iso(Math.max(Date.parse(cutoff), Date.parse(end) - span)), end, page: 1, kind: 'audit' };
  }
}

function completeWindow(cursor: LogCursor, cutoff: string, now: number) {
  const window = cursor.window!;
  if (window.kind === 'backfill') cursor.covered_from = window.start;
  if (window.kind === 'forward') cursor.covered_to = window.end;
  if (window.kind === 'audit') {
    if (window.start <= cutoff) { delete cursor.audit_to; cursor.last_audit_at = now; }
    else cursor.audit_to = window.start;
  }
  delete cursor.window;
}

async function syncLogs(env: Env, row: SyncRow, days: number) {
  const now = Date.now(), cutoff = retentionCutoff(days), deadline = now + RUN_BUDGET_MS;
  const cursor: LogCursor = row.cursor ? JSON.parse(row.cursor) : {};
  if (cursor.window && cursor.window.end <= cutoff) delete cursor.window;
  // A gateway can be offline longer than its retention period. Resume within the
  // still-retained range rather than paging through already-expired gaps.
  if (cursor.covered_from && cursor.covered_from < cutoff) cursor.covered_from = cutoff;
  if (cursor.covered_to && cursor.covered_to < cutoff) cursor.covered_to = cutoff;
  // A slow old head window must not starve fresh requests. History has an independent
  // contiguous watermark, so it will cover the abandoned portion after an outage.
  if (row.job === 'logs:head' && cursor.window && Date.parse(cursor.window.end) < now - 5 * 60000) delete cursor.window;
  let pending = false;
  for (let page = 0; page < PAGE_BUDGET[row.job] && Date.now() < deadline; page++) {
    cursor.window = nextWindow(cursor, row.job, cutoff, now);
    if (!cursor.window) break;
    const window = cursor.window;
    const observedAt = Date.now();
    const result = await fetchLogPage(env, window.start, window.end, window.page, row.job === 'logs:head' ? 'desc' : 'asc');
    if (result.logs.some(log => Date.parse(log.created_at) < Date.parse(window.start) - 1000 || Date.parse(log.created_at) > Date.parse(window.end) + 1000)) {
      throw new ApiError(502, 'cloudflare_log_window_error', 'Cloudflare 返回了时间范围之外的日志，同步进度已保留');
    }
    const signature = result.logs.length ? await sha256(result.logs.map(log => log.id).sort().join('\n')) : '';
    if (window.page > 1 && signature && signature === window.previous_page) {
      throw new ApiError(502, 'cloudflare_log_page_stalled', 'Cloudflare 日志分页未前进，将保留当前进度重试');
    }
    if (result.has_more && !result.logs.length) throw new ApiError(502, 'cloudflare_log_page_stalled', 'Cloudflare 返回了空的中间页，将重试当前页');
    if (result.has_more) { window.page++; window.previous_page = signature; }
    else completeWindow(cursor, cutoff, now);
    const guard = leaseGuard(row), syncedAt = iso(Date.now());
    // Each page and its checkpoint are committed together; failed/expired workers
    // cannot move another owner's cursor or overwrite that owner's data.
    await env.DB.batch([
      ...result.logs.filter(log => log.created_at >= cutoff).map(log => env.DB.prepare(`INSERT INTO observability_logs
        (scope, id, created_at, success, upstream_model, payload, synced_at, observed_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}
        ON CONFLICT(scope, id) DO UPDATE SET created_at = excluded.created_at, success = excluded.success,
          upstream_model = excluded.upstream_model, payload = excluded.payload, synced_at = excluded.synced_at, observed_at = excluded.observed_at
        WHERE excluded.observed_at >= observability_logs.observed_at`)
        .bind(row.scope, log.id, log.created_at, +log.success, log.upstream_model || '', JSON.stringify(log), syncedAt, observedAt, ...guard.values)),
      env.DB.prepare(`UPDATE observability_jobs SET cursor = ?, last_success_at = ?, last_error = NULL
        WHERE scope = ? AND job = ? AND lease_owner = ? AND lease_until > ?`)
        .bind(JSON.stringify(cursor), syncedAt, row.scope, row.job, row.lease_owner, Date.now()),
    ]);
    if (row.job !== 'logs:history' && !cursor.window) break;
  }
  pending = !!cursor.window;
  if (row.job === 'logs:history') pending ||= !!nextWindow(structuredClone(cursor), row.job, cutoff, now);
  return pending;
}

async function syncJob(env: Env, scope: string, job: SyncJobName, days: number) {
  const row = await claimJob(env, scope, job);
  if (!row) return;
  let pending = false, error: string | null = null;
  try {
    if (job.startsWith('stats:')) {
      const range = job === 'stats:7d' ? '7d' : '24h', snapshot = await fetchStats(env, range), guard = leaseGuard(row), now = iso(Date.now());
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO observability_snapshots (scope, range, payload, updated_at) SELECT ?, ?, ?, ? WHERE ${guard.sql}
          ON CONFLICT(scope, range) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`).bind(scope, range, JSON.stringify(snapshot), now, ...guard.values),
        env.DB.prepare('UPDATE observability_jobs SET last_success_at = ?, last_error = NULL WHERE scope = ? AND job = ? AND lease_owner = ? AND lease_until > ?').bind(now, scope, job, row.lease_owner, Date.now()),
      ]);
    } else pending = await syncLogs(env, row, days);
  } catch (cause) {
    // Store only our own sanitized messages, never upstream bodies or credentials.
    error = cause instanceof ApiError ? cause.message : '同步未完成，将在下一轮重试';
  }
  await env.DB.prepare(`UPDATE observability_jobs SET lease_owner = NULL, lease_until = 0, handled_seq = ?, next_run_at = ?, last_error = ?
    WHERE scope = ? AND job = ? AND lease_owner = ?`).bind(row.requested_seq, Date.now() + (pending ? 60 : SYNC_INTERVALS[job]) * 1000, error, scope, job, row.lease_owner).run();
}

export async function syncObservability(env: Env) {
  const scope = observabilityScope(env), settings = await getObservabilitySettings(env);
  await ensureSyncJobs(env, scope);
  // Separate leases and budgets keep failing analytics and historical backfills
  // from blocking recent logs. Only Cron performs upstream calls.
  const results = await Promise.allSettled(JOBS.map(job => syncJob(env, scope, job, settings.log_retention_days)));
  if (results.some(result => result.status === 'rejected')) throw new Error('Observability sync storage failure');
}

export async function cleanObservabilityLogs(env: Env) {
  // Bound cleanup work per tick, including obsolete account/gateway scopes.
  // Read the retention setting inside the deletion to avoid racing a period change.
  await env.DB.prepare(`DELETE FROM observability_logs WHERE rowid IN (
    SELECT rowid FROM observability_logs WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now',
      '-' || (SELECT log_retention_days FROM observability_settings WHERE id = 1) || ' days') LIMIT 5000)`).run();
}
