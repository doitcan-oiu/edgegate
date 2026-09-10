import type { Candidate, Channel, Env, Route } from './types';
import { decryptSecret, encryptionConfigured } from './lib/crypto';
import type { InferenceInput } from './protocols/convert';
import { inferenceToken } from './cloudflare';

export function channelConfigured(channel: Channel, env: Env) {
  if (channel.kind === 'openai') return /^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '') && !!inferenceToken(env) && !!channel.provider_id && !!channel.provider_slug &&
    (channel.secret_encrypted ? encryptionConfigured(env.ENCRYPTION_KEY) : !!channel.byok_alias);
  const token = channel.kind === 'cloudflare' ? env.CF_AI_TOKEN : inferenceToken(env);
  return /^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '') && !!(channel.secret_encrypted || token);
}
export function orderCandidates(candidates: Candidate[], random = Math.random): Candidate[] {
  // Weighted sampling without replacement within each priority tier.
  const pending = [...candidates], result: Candidate[] = [];
  while (pending.length) {
    const priority = Math.min(...pending.map(r => r.priority));
    const tier = pending.filter(r => r.priority === priority);
    let choice = random() * tier.reduce((sum, r) => sum + r.weight, 0);
    const selected = tier.find(r => (choice -= r.weight) < 0) || tier[tier.length - 1];
    result.push(selected); pending.splice(pending.indexOf(selected), 1);
  }
  return result;
}
export async function getCandidates(env: Env, model?: string, allowedTags: string[] = []): Promise<Candidate[]> {
  const { results } = await env.DB.prepare(`SELECT r.*,
    c.name AS c_name, c.kind AS c_kind, c.base_url AS c_base_url,
    c.secret_encrypted AS c_secret, c.timeout_ms AS c_timeout, c.created_at AS c_created,
    c.provider_id AS c_provider_id, c.provider_slug AS c_provider_slug, c.gateway_path AS c_path, c.byok_alias AS c_alias, COALESCE(p.protocol, 'openai') AS c_protocol, COALESCE(p.tags, '[]') AS c_tags
    FROM routes r JOIN channels c ON c.id = r.channel_id JOIN models m ON m.id = r.model_id LEFT JOIN provider_profiles p ON p.provider_id = c.provider_id
    WHERE (? IS NULL OR r.model_id = ?) AND (json_array_length(?) = 0 OR EXISTS (SELECT 1 FROM json_each(p.tags) AS tag JOIN json_each(?) AS allowed ON tag.value = allowed.value)) AND r.enabled = 1 AND c.enabled = 1 AND m.enabled = 1 ORDER BY r.priority, r.id`).bind(model ?? null, model ?? null, JSON.stringify(allowedTags), JSON.stringify(allowedTags)).all<Route & {
      c_name: string; c_kind: Channel['kind']; c_base_url: string; c_secret: string | null; c_timeout: number; c_created: string;
      c_protocol: 'openai' | 'anthropic'; c_tags: string; c_provider_id: string | null; c_provider_slug: string | null; c_path: string; c_alias: string;
    }>();
  return results.map(r => ({ ...r, channel: {
    protocol: r.c_protocol, tags: JSON.parse(r.c_tags), id: r.channel_id, name: r.c_name, kind: r.c_kind, base_url: r.c_base_url, secret_encrypted: r.c_secret,
    enabled: 1, timeout_ms: r.c_timeout, created_at: r.c_created,
    provider_id: r.c_provider_id, provider_slug: r.c_provider_slug, gateway_path: r.c_path, byok_alias: r.c_alias,
  } })).filter(r => channelConfigured(r.channel, env));
}
export async function requestUpstream(env: Env, candidate: Candidate, input: InferenceInput, metadata: Record<string, string>, signal: AbortSignal, inboundHeaders?: Headers) {
  const { channel } = candidate;
  const token = channel.secret_encrypted
    ? await decryptSecret(channel.secret_encrypted, env.ENCRYPTION_KEY, channel.id)
    : channel.kind === 'cloudflare' ? env.CF_AI_TOKEN : inferenceToken(env);
  const headers = new Headers({ 'Content-Type': 'application/json' });
  let url: string;
  if (channel.kind === 'cloudflare') {
    url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`;
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('cf-aig-gateway-id', env.AI_GATEWAY_ID || 'default');
  } else if (channel.kind === 'ai-gateway') {
    url = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${encodeURIComponent(env.AI_GATEWAY_ID || 'default')}/compat/chat/completions`;
    headers.set('cf-aig-authorization', `Bearer ${token}`);
  } else {
    url = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${encodeURIComponent(env.AI_GATEWAY_ID || 'default')}/custom-${encodeURIComponent(channel.provider_slug!)}/${channel.gateway_path}`;
    headers.set('cf-aig-authorization', `Bearer ${inferenceToken(env)}`);
    if (channel.secret_encrypted) {
      if (channel.protocol === 'anthropic') headers.set('x-api-key', token!);
      else headers.set('Authorization', `Bearer ${token}`);
    } else {
      headers.set('cf-aig-byok-alias', channel.byok_alias);
    }
  }
  if (channel.protocol === 'anthropic') {
    headers.set('anthropic-version', inboundHeaders?.get('anthropic-version') || '2023-06-01');
    const beta = inboundHeaders?.get('anthropic-beta');
    if (beta) headers.set('anthropic-beta', beta);
  }
  // Logging and caching follow AI Gateway's configuration; do not disable its observability.
  headers.set('cf-aig-metadata', JSON.stringify(metadata));
  const body = { ...input, model: candidate.upstream_model };
  // Redirects must never forward provider credentials to another destination.
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'manual' });
}
