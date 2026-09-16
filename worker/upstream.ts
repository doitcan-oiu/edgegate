import type { Candidate, Channel, Env, Route, RouteGroup } from './types';
import { decryptSecret, encryptionConfigured, sha256 } from './lib/crypto';
import type { InferenceInput } from './protocols/convert';
import { inferenceToken } from './cloudflare';
import type { GatewaySettings } from '../shared/gateway-settings';

export function channelConfigured(channel: Channel, env: Env) {
  if (channel.kind === 'openai') return /^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '') && !!inferenceToken(env) && !!channel.provider_id && !!channel.provider_slug &&
    (channel.secret_encrypted ? encryptionConfigured(env.ENCRYPTION_KEY) : !!channel.byok_alias);
  const token = channel.kind === 'cloudflare' ? env.CF_AI_TOKEN : inferenceToken(env);
  return /^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '') && !!(channel.secret_encrypted || token);
}
export function orderCandidates(candidates: Candidate[], random = Math.random, strategy: GatewaySettings['load_balancing'] = 'weighted', randomUnit: 'channel' | 'route' = 'channel'): Candidate[] {
  // Priority wins first. A failed channel cannot re-enter via another route.
  const pending = [...candidates], result: Candidate[] = [];
  while (pending.length) {
    const priority = Math.min(...pending.map(r => r.priority));
    const tier = pending.filter(r => r.priority === priority);
    const channelId = (r: Candidate) => r.channel_id || r.id;
    let selected: Candidate;
    if (strategy === 'random' && randomUnit === 'route') {
      selected = tier[Math.min(tier.length - 1, Math.floor(random() * tier.length))];
    } else if (strategy === 'random') {
      const channelIds = [...new Set(tier.map(channelId))];
      const channel = channelIds[Math.min(channelIds.length - 1, Math.floor(random() * channelIds.length))];
      const routes = tier.filter(r => channelId(r) === channel);
      selected = routes[Math.min(routes.length - 1, Math.floor(random() * routes.length))];
    } else {
      let choice = random() * tier.reduce((sum, r) => sum + r.weight, 0);
      selected = tier.find(r => (choice -= r.weight) < 0) || tier[tier.length - 1];
    }
    result.push(selected);
    for (let i = pending.length - 1; i >= 0; i--) if (channelId(pending[i]) === channelId(selected)) pending.splice(i, 1);
  }
  return result;
}

type CandidateGroup = { group: RouteGroup | null; candidates: Candidate[] };

function orderCandidateGroups(candidates: Candidate[], random: () => number, strategy: GatewaySettings['load_balancing']): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();
  for (const candidate of candidates) {
    if (candidate.group?.enabled === 0) continue;
    const key = candidate.group ? `group:${candidate.group.id}` : `default:${candidate.model_id}`;
    const entry = groups.get(key) || { group: candidate.group || null, candidates: [] };
    entry.candidates.push(candidate);
    groups.set(key, entry);
  }
  const pending = [...groups.values()], result: CandidateGroup[] = [];
  while (pending.length) {
    const priority = Math.min(...pending.map(entry => entry.group?.priority ?? 0));
    const tier = pending.filter(entry => (entry.group?.priority ?? 0) === priority);
    let selected: CandidateGroup;
    if (tier.length === 1) selected = tier[0];
    else if (strategy === 'random') selected = tier[Math.min(tier.length - 1, Math.floor(random() * tier.length))];
    else {
      let choice = random() * tier.reduce((sum, entry) => sum + (entry.group?.weight ?? 1), 0);
      selected = tier.find(entry => (choice -= entry.group?.weight ?? 1) < 0) || tier[tier.length - 1];
    }
    result.push(selected);
    pending.splice(pending.indexOf(selected), 1);
  }
  return result;
}

// Allocate only when a request reaches this group's priority tier. The atomic D1
// cursor works across isolates; separate authorized route sets cannot skew it.
async function roundRobinTier(env: Env, group: RouteGroup, priority: number, candidates: Candidate[]): Promise<Candidate[]> {
  const routes = [...candidates].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const scope = await sha256(JSON.stringify(routes.map(route => route.id)));
  const cursor = await env.DB.prepare(`INSERT INTO route_group_cursors (group_id, priority, scope, position) VALUES (?, ?, ?, 0)
    ON CONFLICT(group_id, priority, scope) DO UPDATE SET position = (route_group_cursors.position + 1) % ?
    RETURNING position`).bind(group.id, priority, scope, routes.length).first<{ position: number }>();
  if (!cursor) throw new Error('Unable to allocate route group round-robin position');
  const start = cursor.position % routes.length;
  return [...routes.slice(start), ...routes.slice(0, start)];
}

export async function* iterateCandidates(env: Env, candidates: Candidate[], random = Math.random, strategy: GatewaySettings['load_balancing'] = 'weighted'): AsyncGenerator<Candidate> {
  const tried = new Set<string>();
  const channelId = (candidate: Candidate) => candidate.channel_id || candidate.id;
  for (const { group, candidates: routes } of orderCandidateGroups(candidates, random, strategy)) {
    // Finish all priorities inside the selected group before trying another group.
    const priorities = [...new Set(routes.map(route => route.priority))].sort((a, b) => a - b);
    for (const priority of priorities) {
      const tier = routes.filter(route => route.priority === priority);
      const remaining = tier.filter(route => !tried.has(channelId(route)));
      if (!remaining.length) continue;
      const ordered = group?.strategy === 'round_robin'
        ? await roundRobinTier(env, group, priority, tier)
        : orderCandidates(remaining, random, group?.strategy || strategy, group ? 'route' : 'channel');
      for (const candidate of ordered) {
        if (tried.has(channelId(candidate))) continue;
        tried.add(channelId(candidate));
        yield candidate;
      }
    }
  }
}

export async function getCandidates(env: Env, model?: string, allowedTags: string[] = []): Promise<Candidate[]> {
  const { results } = await env.DB.prepare(`SELECT r.*,
    g.id AS g_id, g.model_id AS g_model_id, g.name AS g_name, g.priority AS g_priority, g.weight AS g_weight,
    g.strategy AS g_strategy, g.enabled AS g_enabled, g.created_at AS g_created,
    c.name AS c_name, c.kind AS c_kind, c.base_url AS c_base_url,
    c.secret_encrypted AS c_secret, c.timeout_ms AS c_timeout, c.created_at AS c_created, c.auto_create_routes AS c_auto_routes,
    c.provider_id AS c_provider_id, c.provider_slug AS c_provider_slug, c.gateway_path AS c_path, c.byok_alias AS c_alias, COALESCE(p.protocol, 'openai') AS c_protocol, COALESCE(p.tags, '[]') AS c_tags
    FROM routes r JOIN channels c ON c.id = r.channel_id JOIN models m ON m.id = r.model_id LEFT JOIN provider_profiles p ON p.provider_id = c.provider_id
    LEFT JOIN route_groups g ON g.id = r.group_id AND g.model_id = r.model_id
    WHERE (? IS NULL OR r.model_id = ?) AND (json_array_length(?) = 0 OR EXISTS (
      SELECT 1 FROM json_each(CASE WHEN r.scope_tag != '' THEN json_array(r.scope_tag) ELSE COALESCE(p.tags, '[]') END) AS tag
      JOIN json_each(?) AS allowed ON tag.value = allowed.value
    )) AND r.enabled = 1 AND c.enabled = 1 AND m.enabled = 1 AND (r.group_id IS NULL OR g.enabled = 1) ORDER BY r.priority, r.id`).bind(model ?? null, model ?? null, JSON.stringify(allowedTags), JSON.stringify(allowedTags)).all<Route & {
      g_id: string | null; g_model_id: string; g_name: string; g_priority: number; g_weight: number; g_strategy: RouteGroup['strategy']; g_enabled: number; g_created: string;
      c_name: string; c_kind: Channel['kind']; c_base_url: string; c_secret: string | null; c_timeout: number; c_created: string; c_auto_routes: number;
      c_protocol: NonNullable<Channel['protocol']>; c_tags: string; c_provider_id: string | null; c_provider_slug: string | null; c_path: string; c_alias: string;
    }>();
  return results.map(r => ({ ...r, group: r.g_id ? { id: r.g_id, model_id: r.g_model_id, name: r.g_name, priority: r.g_priority, weight: r.g_weight, strategy: r.g_strategy, enabled: r.g_enabled, created_at: r.g_created } : null, channel: {
    protocol: r.c_protocol, tags: JSON.parse(r.c_tags), id: r.channel_id, name: r.c_name, kind: r.c_kind, base_url: r.c_base_url, secret_encrypted: r.c_secret,
    enabled: 1, timeout_ms: r.c_timeout, created_at: r.c_created, auto_create_routes: r.c_auto_routes,
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
