export interface GatewaySettings {
  load_balancing: 'random' | 'weighted';
  same_channel_retries: number;
  cross_channel_retries: number;
  upstream_error_mode: 'show' | 'hide' | 'custom';
  upstream_error_rules: { code: string; message: string }[];
}

export const DEFAULT_GATEWAY_SETTINGS: GatewaySettings = {
  load_balancing: 'weighted', same_channel_retries: 0, cross_channel_retries: 4,
  upstream_error_mode: 'hide', upstream_error_rules: [],
};

export interface UpstreamErrorTrace {
  request_id: string; attempt: number; channel_id: string; channel_name: string;
  upstream_model: string; cf_log_id: string | null; status: number | null;
  error_code: string; error_body: string; truncated: number; created_at: string;
}
