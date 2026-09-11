export type SyncJobName = 'stats:24h' | 'stats:7d' | 'logs:head' | 'logs:repair' | 'logs:history';
export const SYNC_INTERVALS: Record<SyncJobName, number> = {
  'stats:24h': 300, 'stats:7d': 900, 'logs:head': 120, 'logs:repair': 900, 'logs:history': 120,
};
export interface SyncJobStatus {
  job: SyncJobName;
  state: 'waiting' | 'queued' | 'running' | 'error' | 'ready';
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  stale: boolean;
}
export interface ObservabilityStatus {
  settings: { log_retention_days: 7 | 30 };
  jobs: SyncJobStatus[];
  logs: { total: number; oldest_at: string | null; newest_at: string | null;
    covered_from: string | null; covered_to: string | null; backfilling: boolean };
}
