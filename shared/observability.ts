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
  source: 'cloudflare'; coverage: 'complete' | 'partial'; sampled_logs: number; fetched_at: string;
  warning?: string;
}
