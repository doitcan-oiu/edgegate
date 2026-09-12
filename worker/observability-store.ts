import { z } from 'zod';
import type { Env } from './types';
import { accountId, gatewayId } from './cloudflare';
import { SYNC_INTERVALS, type SyncJobName, type SyncJobStatus, type ObservabilityStatus } from '../shared/observability';

export const DAY = 86400000;
export const JOBS = Object.keys(SYNC_INTERVALS) as SyncJobName[];
export interface SyncRow {
  scope: string; job: SyncJobName; cursor: string | null; next_run_at: number;
  requested_seq: number; handled_seq: number; lease_owner: string | null; lease_until: number;
  last_attempt_at: string | null; last_success_at: string | null; last_error: string | null;
}
export interface LogCursor {
  version: 2;
  scan?: { page: number; started_at: string; stop_before: string };
  // Bounds of the last finished newest-first pass, not a snapshot guarantee.
  covered_from?: string; covered_to?: string;
}
export function readLogCursor(value: string | null | undefined): LogCursor {
  const cursor = value ? JSON.parse(value) as Partial<LogCursor> : null;
  // Old filtered-window checkpoints cannot resume against an unfiltered list.
  // Only the checkpoint resets; previously cached logs remain available.
  return cursor?.version === 2 ? cursor as LogCursor : { version: 2 };
}
// Token rotation must not discard the fallback data for the same resource.
export const observabilityScope = (env: Env) => JSON.stringify(['v1', accountId(env), gatewayId(env)]);
export const retentionCutoff = (days: number) => new Date(Date.now() - days * DAY).toISOString();
export const observabilitySettingsSchema = z.object({ log_retention_days: z.union([z.literal(7), z.literal(30)]) }).strict();

export async function getObservabilitySettings(env: Env) {
  return await env.DB.prepare('SELECT log_retention_days FROM observability_settings WHERE id = 1').first<{ log_retention_days: 7 | 30 }>() || { log_retention_days: 7 as const };
}
export async function saveObservabilitySettings(env: Env, input: unknown) {
  const settings = observabilitySettingsSchema.parse(input);
  await env.DB.batch([
    // Reset coverage on a changed retention period, including 30 -> 7 -> 30.
    // Revoking leases prevents in-flight old settings from restoring stale watermarks.
    env.DB.prepare(`UPDATE observability_jobs SET cursor = NULL, lease_owner = NULL, lease_until = 0, next_run_at = 0
      WHERE job LIKE 'logs:%' AND EXISTS (SELECT 1 FROM observability_settings WHERE id = 1 AND log_retention_days != ?)`)
      .bind(settings.log_retention_days),
    env.DB.prepare('UPDATE observability_settings SET log_retention_days = ? WHERE id = 1').bind(settings.log_retention_days),
  ]);
  return settings;
}
export async function ensureSyncJobs(env: Env, scope: string) {
  await env.DB.batch(JOBS.map(job => env.DB.prepare('INSERT OR IGNORE INTO observability_jobs (scope, job) VALUES (?, ?)').bind(scope, job)));
}
export function jobStatus(job: SyncJobName, row?: SyncRow | null): SyncJobStatus {
  const now = Date.now();
  return { job, state: row && row.lease_until > now ? 'running' : row && row.requested_seq > row.handled_seq ? 'queued'
    : row?.last_error ? 'error' : row?.last_success_at ? 'ready' : 'waiting',
    last_attempt_at: row?.last_attempt_at || null, last_success_at: row?.last_success_at || null, last_error: row?.last_error || null,
    stale: !row?.last_success_at || now - Date.parse(row.last_success_at) > (SYNC_INTERVALS[job] + 120) * 1000,
  };
}
export async function getSyncStatus(env: Env, scope: string, job: SyncJobName) {
  return jobStatus(job, await env.DB.prepare('SELECT * FROM observability_jobs WHERE scope = ? AND job = ?').bind(scope, job).first<SyncRow>());
}
export async function getObservabilityStatus(env: Env): Promise<ObservabilityStatus> {
  const scope = observabilityScope(env), settings = await getObservabilitySettings(env), cutoff = retentionCutoff(settings.log_retention_days);
  const [rows, counts] = await Promise.all([
    env.DB.prepare('SELECT * FROM observability_jobs WHERE scope = ?').bind(scope).all<SyncRow>(),
    env.DB.prepare('SELECT COUNT(*) AS total, MIN(created_at) AS oldest_at, MAX(created_at) AS newest_at FROM observability_logs WHERE scope = ? AND created_at >= ?').bind(scope, cutoff).first<{ total: number; oldest_at: string | null; newest_at: string | null }>(),
  ]);
  const history = rows.results.find(row => row.job === 'logs:history');
  const cursor = readLogCursor(history?.cursor);
  return { settings, jobs: JOBS.map(job => jobStatus(job, rows.results.find(row => row.job === job))),
    logs: { total: counts?.total || 0, oldest_at: counts?.oldest_at || null, newest_at: counts?.newest_at || null,
      covered_from: cursor.covered_from ? (cursor.covered_from < cutoff ? cutoff : cursor.covered_from) : null,
      covered_to: cursor.covered_to || null, backfilling: !!cursor.scan || !cursor.covered_from || !cursor.covered_to },
  };
}

export async function requestObservabilitySync(env: Env) {
  const scope = observabilityScope(env);
  await ensureSyncJobs(env, scope);
  // Persist before responding. Cron owns the work, independent of HTTP waitUntil's lifetime.
  // Coalesce clicks while queued/running instead of multiplying Cloudflare calls.
  await env.DB.prepare(`UPDATE observability_jobs SET requested_seq = requested_seq + 1
    WHERE scope = ? AND requested_seq = handled_seq AND lease_until <= ?`).bind(scope, Date.now()).run();
  return { queued: true };
}
