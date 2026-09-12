import type { Env } from './types';
import { fetchLogPage, fetchStats } from './cloudflare-observability';
import { ApiError } from './lib/errors';
import { sha256 } from './lib/crypto';
import { SYNC_INTERVALS, type SyncJobName } from '../shared/observability';
import { JOBS, ensureSyncJobs, getObservabilitySettings, observabilityScope, readLogCursor, retentionCutoff, type LogCursor, type SyncRow } from './observability-store';

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

async function saveLogPage(env: Env, row: SyncRow, cursor: LogCursor,
  logs: Awaited<ReturnType<typeof fetchLogPage>>['logs'], cutoff: string, observedAt: number) {
  const guard = leaseGuard(row), syncedAt = iso(Date.now());
  // Each page and its checkpoint commit together. Expired/revoked workers cannot
  // advance another owner's cursor or overwrite newer observations of SSE usage.
  const saved = await env.DB.batch([
    ...logs.filter(log => log.created_at >= cutoff).map(log => env.DB.prepare(`INSERT INTO observability_logs
      (scope, id, created_at, success, upstream_model, payload, synced_at, observed_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}
      ON CONFLICT(scope, id) DO UPDATE SET created_at = excluded.created_at, success = excluded.success,
        upstream_model = excluded.upstream_model, payload = excluded.payload, synced_at = excluded.synced_at, observed_at = excluded.observed_at
      WHERE excluded.observed_at >= observability_logs.observed_at`)
      .bind(row.scope, log.id, log.created_at, +log.success, log.upstream_model || '', JSON.stringify(log), syncedAt, observedAt, ...guard.values)),
    env.DB.prepare(`UPDATE observability_jobs SET cursor = ?, last_success_at = ?, last_error = NULL
      WHERE scope = ? AND job = ? AND lease_owner = ? AND lease_until > ?`)
      .bind(JSON.stringify(cursor), syncedAt, row.scope, row.job, row.lease_owner, Date.now()),
  ]);
  return saved.at(-1)!.meta.changes > 0;
}

async function syncLogs(env: Env, row: SyncRow, days: number) {
  const now = Date.now(), cutoff = retentionCutoff(days), deadline = now + RUN_BUDGET_MS;
  const cursor = readLogCursor(row.cursor), head = row.job === 'logs:head';
  // Always refresh the newest records independently of a long historical scan.
  // Repair/history restart at the front after each pass to revisit updated IDs
  // and recover from changes in the remote list's offset-based pagination.
  if (head) delete cursor.scan;
  cursor.scan ||= { page: 1, started_at: iso(now), stop_before: row.job === 'logs:repair' ? iso(now - 2 * 3600000) : cutoff };
  const scan = cursor.scan;
  if (scan.stop_before < cutoff) scan.stop_before = cutoff;
  // Overlap the preceding page on continuation; new/deleted remote records can
  // move page boundaries. IDs deduplicate both overlap and same-timestamp rows.
  let page = Math.max(1, scan.page - 1), previousPage = '';
  for (let fetched = 0; fetched < PAGE_BUDGET[row.job] && Date.now() < deadline; fetched++, page++) {
    const observedAt = Date.now(), result = await fetchLogPage(env, page);
    if (fetched === 0 && page > 1 && !result.logs.length && !result.has_more) {
      // Remote deletions can put a saved offset beyond the new end. An empty
      // resume page does not establish that we read the surviving middle pages.
      scan.page = 1; scan.started_at = iso(now);
      if (!await saveLogPage(env, row, cursor, [], cutoff, observedAt)) return false;
      page = 0;
      continue;
    }
    const signature = result.logs.length ? await sha256(result.logs.map(log => log.id).sort().join('\n')) : '';
    if ((signature && signature === previousPage) || (result.has_more && !result.logs.length)) {
      // A repeated/empty intermediate page is not proof we reached the end.
      // Restart next time rather than getting stuck on the same bad checkpoint.
      cursor.scan = { page: 1, started_at: iso(now), stop_before: scan.stop_before };
      await env.DB.prepare(`UPDATE observability_jobs SET cursor = ?
        WHERE scope = ? AND job = ? AND lease_owner = ? AND lease_until > ?`)
        .bind(JSON.stringify(cursor), row.scope, row.job, row.lease_owner, Date.now()).run();
      throw new ApiError(502, 'cloudflare_log_page_stalled', 'Cloudflare 日志分页未前进，下一轮将从最新日志重新读取');
    }
    previousPage = signature;
    // No upstream date range is requested or enforced. Only local retention /
    // SSE lookback limits how far backward a pass needs to read. Check the whole
    // page so a single old timestamp never discards newer records beside it.
    const complete = !result.has_more || (result.logs.length > 0 && result.logs.every(log => log.created_at < scan.stop_before));
    if (complete) {
      cursor.covered_from = scan.stop_before;
      cursor.covered_to = scan.started_at;
      delete cursor.scan;
    } else scan.page = Math.max(scan.page, page + 1);
    if (!await saveLogPage(env, row, cursor, result.logs, cutoff, observedAt)) return false;
    if (complete) break;
  }
  return !head && !!cursor.scan;
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
