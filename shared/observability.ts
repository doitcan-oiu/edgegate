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

export const CHANNEL_AVAILABILITY_WINDOW_MS = 60 * 60 * 1000;
export const CHANNEL_AVAILABILITY_BUCKET_MS = 2 * 60 * 1000;
export const CHANNEL_AVAILABILITY_BUCKET_COUNT = CHANNEL_AVAILABILITY_WINDOW_MS / CHANNEL_AVAILABILITY_BUCKET_MS;

export interface ChannelAvailabilityBucket {
  start: string; end: string; requests: number; successes: number; rate: number | null;
}
export interface ChannelAvailability {
  channel_id: string; requests: number; successes: number; rate: number | null;
  buckets: ChannelAvailabilityBucket[];
}
export interface ChannelAvailabilityResponse {
  data: ChannelAvailability[]; window_start: string; window_end: string;
  storage: 'd1'; source: 'cloudflare'; sync: SyncJobStatus; jobs: SyncJobStatus[]; backfilling: boolean;
}
