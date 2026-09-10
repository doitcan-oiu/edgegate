export interface Channel {
  protocol: 'openai' | 'anthropic'; tags: string[]; models: string[];
  id: string; name: string; kind: 'cloudflare' | 'ai-gateway' | 'openai'; base_url: string;
  enabled: number; timeout_ms: number; has_secret: boolean; configured: boolean; created_at: string;
  provider_id: string | null; provider_slug: string | null; gateway_path: string; byok_alias: string;
}
export interface ProviderProfile { protocol: 'openai' | 'anthropic'; tags: string[]; models: string[] }
export interface CustomProvider extends ProviderProfile { id: string; name: string; slug: string; base_url: string; enable?: boolean; description?: string }
export interface ProviderPage { data: CustomProvider[]; page: number; total: number | null; has_more: boolean }
export interface Route {
  id: string; model_id: string; channel_id: string; upstream_model: string;
  priority: number; weight: number; input_price: number | null; output_price: number | null; enabled: number;
}
export interface Model { id: string; description: string; enabled: number; created_at: string; routes: Route[] }
export interface ApiKey {
  allowed_tags: string[];
  id: string; name: string; prefix: string; allowed_models: string[]; rpm: number; daily_limit: number;
  expires_at: string | null; revoked_at: string | null; created_at: string; requests_today: number;
}
export interface Log {
  id: string; request_id: string | null; model: string; channel_name: string; key_name: string; status: number | null; success: boolean; latency_ms: number;
  input_tokens: number | null; output_tokens: number | null; cost_usd: number | null;
  cached: number; stream: number; attempts: number | null; error_code: string | null; created_at: string; upstream_model: string | null; provider: string;
}
export interface LogPage { data: Log[]; total: number | null; page: number; page_size: number; has_more: boolean; source: 'cloudflare' }
export interface Config {
  account_id: string; gateway_id: string; ai_token_configured: boolean; aig_token_configured: boolean;
  encryption_configured: boolean; control_token_configured: boolean; observability_source: 'cloudflare'; dashboard_url: string;
}
export interface Stats {
  summary: { requests: number; successes: number | null; input_tokens: number | null; output_tokens: number | null;
    cost_usd: number | null; cache_hits: number | null };
  series: { time: string; requests: number; errors: number | null }[];
  models: { model: string; requests: number }[]; range: '24h' | '7d';
  source: 'cloudflare'; scope: 'gateway'; gateway_id: string;
}
