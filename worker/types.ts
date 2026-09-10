export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;
  ADMIN_TOKEN?: string;
  ENCRYPTION_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  CF_AI_TOKEN?: string;
  CF_AIG_TOKEN?: string;
  CF_API_TOKEN?: string;
}
export type AppEnv = { Bindings: Env; Variables: { requestId: string; sessionId: string } };
export type Protocol = 'openai' | 'anthropic';
export interface ProviderProfile { protocol: Protocol; tags: string[]; models: string[] }
export interface Channel {
  id: string; name: string; kind: 'cloudflare' | 'ai-gateway' | 'openai';
  base_url: string; secret_encrypted: string | null; enabled: number; timeout_ms: number;
  created_at: string;
  provider_id: string | null; provider_slug: string | null; gateway_path: string; byok_alias: string;
  protocol?: Protocol; tags?: string[];
}
export interface Model { id: string; description: string; enabled: number; created_at: string }
export interface Route {
  id: string; model_id: string; channel_id: string; upstream_model: string;
  priority: number; weight: number; input_price: number | null; output_price: number | null; enabled: number;
}
export type Candidate = Route & { channel: Channel };
export interface ApiKey {
  id: string; name: string; key_hash: string; prefix: string; allowed_models: string;
  allowed_tags: string;
  rpm: number; daily_limit: number; expires_at: string | null; revoked_at: string | null; created_at: string;
}
