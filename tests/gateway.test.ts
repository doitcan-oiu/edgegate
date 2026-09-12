import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { Miniflare, convertV4MiniflareOptions, Response as MFResponse, type Request as MFRequest } from 'miniflare';
import { decryptSecret, encryptSecret } from '../worker/lib/crypto';
import { orderCandidates } from '../worker/upstream';
import { safeBaseUrl } from '../worker/lib/validation';
import { normalizeLog } from '../worker/cloudflare-observability';
import type { ChannelAvailabilityResponse } from '../shared/observability';
import type { Candidate, Channel, Env, Model, Protocol, Route } from '../worker/types';
import worker from '../worker/index';
import { DEFAULT_GATEWAY_SETTINGS, type GatewaySettings, type UpstreamErrorTrace } from '../shared/gateway-settings';

const ADMIN = 'test-admin-token-with-at-least-32-characters';
const ENCRYPTION = btoa('12345678901234567890123456789012');
const completion = { id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'upstream-test', choices: [{ index: 0, message: { role: 'assistant', content: '你好，世界' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 } };
const account = 'a'.repeat(32), root = `/client/v4/accounts/${account}/ai-gateway`;
type Recorded = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
type Provider = { id: string; name: string; slug: string; base_url: string; enable: boolean; headers?: string };
type RemoteLog = { id: string; model: string; provider: string; success: boolean; status_code?: number; tokens_in: number | null; tokens_out: number | null; duration: number; cost?: number; cached: boolean; created_at: string; metadata?: string; request_head?: string };
let mf: Miniflare, db: Awaited<ReturnType<Miniflare['getD1Database']>>, cookie = '';
let upstream: (request: MFRequest) => Promise<MFResponse> | MFResponse;
let calls: Recorded[], modelCalls: Recorded[], controlCalls: Recorded[], providers: Map<string, Provider>, remoteLogs: RemoteLog[];
let modelResponse: (request: MFRequest) => Promise<MFResponse> | MFResponse;
let controlFailure = 0, graphqlFailure = false;
let controlStatuses: number[] = [];
let logPageInfo: 'pages' | 'count' | 'none' = 'pages';
const ok = (result: unknown, info?: unknown) => MFResponse.json({ success: true, result, ...(info ? { result_info: info } : {}) });
const fail = (status: number) => MFResponse.json({ success: false, errors: [{ message: 'sensitive Cloudflare response' }] }, { status });

async function outbound(req: MFRequest): Promise<MFResponse> {
  const url = new URL(req.url), body = req.method === 'GET' || req.method === 'DELETE' ? {} : await req.clone().json() as Record<string, unknown>;
  const record = { url: req.url, headers: Object.fromEntries(req.headers), body };
  if (url.hostname === 'api.cloudflare.com' && !url.pathname.includes('/ai/v1/')) {
    controlCalls.push(record);
    const status = controlStatuses.shift() || controlFailure;
    if (status) return fail(status);
    // This account has no Secrets Store permissions; custom keys must stay in D1.
    if (url.pathname.includes('/secrets_store/') || url.pathname.endsWith('/provider_configs')) return fail(403);
    if (url.pathname.endsWith('/graphql')) {
      if (graphqlFailure) return MFResponse.json({ errors: [{ message: 'no analytics permissions' }], data: null });
      if (String(body.query).includes('__type')) return MFResponse.json({ data: { sum: { fields: ['tokensIn', 'tokensOut', 'cost', 'erroredRequests', 'cachedRequests'].map(name => ({ name })) } } });
      return MFResponse.json({ data: { viewer: { accounts: [{ summary: [{ count: 12345, sum: { tokensIn: 500000, tokensOut: 100000, cost: 4.25, erroredRequests: 45, cachedRequests: 1000 } }], series: [{ count: 12345, dimensions: { ts: new Date().toISOString().slice(0, 13) + ':00:00Z' }, sum: { erroredRequests: 45 } }], models: [{ count: 12345, dimensions: { model: 'cloud-model' } }] }] } } });
    }
    if (url.pathname === `${root}/custom-providers`) {
      if (req.method === 'POST') {
        if ([...providers.values()].some(p => p.slug === body.slug)) return fail(409);
        const provider = { ...body, id: crypto.randomUUID() } as Provider;
        providers.set(provider.id, provider); return ok(provider);
      }
      let rows = [...providers.values()];
      if (url.searchParams.get('search')) rows = rows.filter(p => p.name.includes(url.searchParams.get('search')!) || p.slug.includes(url.searchParams.get('search')!));
      const page = Number(url.searchParams.get('page') || 1), per = Number(url.searchParams.get('per_page') || 50);
      return ok(rows.slice((page - 1) * per, page * per), { total_count: rows.length, total_pages: Math.ceil(rows.length / per) });
    }
    if (url.pathname.startsWith(`${root}/custom-providers/`)) {
      const id = url.pathname.split('/').at(-1)!, provider = providers.get(id);
      if (!provider) return fail(404);
      if (req.method === 'PATCH') { Object.assign(provider, body); return ok(provider); }
      if (req.method === 'DELETE') providers.delete(id);
      return ok(provider);
    }
    if (url.pathname === `${root}/gateways/test-gateway/logs`) {
      const page = Number(url.searchParams.get('page') || 1), per = Number(url.searchParams.get('per_page') || 25);
      let rows = [...remoteLogs].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      if (url.searchParams.has('success')) rows = rows.filter(row => row.success === (url.searchParams.get('success') === 'true'));
      if (url.searchParams.has('model')) rows = rows.filter(row => row.model === url.searchParams.get('model'));
      if (url.searchParams.has('search')) rows = rows.filter(row => row.id.includes(url.searchParams.get('search')!));
      const info = logPageInfo === 'none' ? undefined : { total_count: rows.length, ...(logPageInfo === 'pages' ? { total_pages: Math.ceil(rows.length / per) } : {}) };
      return ok(rows.slice((page - 1) * per, page * per), info);
    }
    if (url.pathname.startsWith(`${root}/gateways/test-gateway/logs/`)) return remoteLogs.find(l => l.id === url.pathname.split('/').at(-1)) ? ok(remoteLogs.find(l => l.id === url.pathname.split('/').at(-1))) : fail(404);
    return fail(404);
  }
  // Only read-only model discovery may contact suppliers directly; inference must use Cloudflare.
  if (req.method === 'GET' && url.pathname.endsWith('/v1/models')) {
    modelCalls.push(record); return modelResponse(req);
  }
  if (url.hostname !== 'gateway.ai.cloudflare.com' && url.hostname !== 'api.cloudflare.com') throw new Error(`Direct provider egress forbidden: ${url.hostname}`);
  calls.push(record);
  const response = await upstream(req);
  response.headers.set('cf-aig-log-id', `cf-log-${calls.length}`);
  return response;
}
async function request(path: string, options: { method?: string; body?: unknown; key?: string; admin?: boolean; headers?: Record<string, string> } = {}) {
  return mf.dispatchFetch(`https://edgegate.example${path}`, {
    method: options.method || (options.body ? 'POST' : 'GET'),
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.admin ? { Cookie: cookie } : {}), ...(options.key ? { Authorization: `Bearer ${options.key}` } : {}), ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}
async function admin<T = Record<string, unknown>>(path: string, body?: unknown, method?: string): Promise<T> {
  const result = await request(`/api${path}`, { admin: true, body, method }), json = await result.json();
  expect(result.status, JSON.stringify(json)).toBeLessThan(300); return json as T;
}
async function key(options = {}) { return admin<{ id: string; key: string }>('/keys', { name: 'Test app', ...options }); }
async function channel(name: string, host: string, secret = 'provider-secret') {
  return (await admin<{ id: string }>('/channels', { name, kind: 'openai', provider_slug: name.toLowerCase(), base_url: `https://${host}`, gateway_path: 'v1/chat/completions', secret })).id;
}
async function route(channelId: string, priority = 0, upstreamModel = 'upstream-test') {
  return admin<{ id: string }>('/routes', { model_id: 'test-model', channel_id: channelId, upstream_model: upstreamModel, priority });
}
const chat = (token: string, extra = {}) => request('/v1/chat/completions', { key: token, body: { model: 'test-model', messages: [{ role: 'user', content: 'private prompt' }], ...extra } });
const runtime = (update: Partial<GatewaySettings>) => admin<GatewaySettings>('/config/runtime', { ...DEFAULT_GATEWAY_SETTINGS, ...update }, 'PUT');
function logFixture(overrides: Partial<RemoteLog> = {}): RemoteLog { return { id: 'cf-remote-log', model: 'cloud-model', provider: 'custom-primary', status_code: 200, success: true, tokens_in: 7, tokens_out: 11, duration: 1234, cost: 0.0001, cached: false, created_at: new Date().toISOString(), metadata: JSON.stringify({ request_id: 'edge-request', model_alias: 'test-model', key_name: 'Test app', attempt: '1', channel_name: 'Primary' }), ...overrides }; }

beforeAll(async () => {
  const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'edgegate-test', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'],
    bindings: { ADMIN_TOKEN: ADMIN, ENCRYPTION_KEY: ENCRYPTION, CLOUDFLARE_ACCOUNT_ID: account, AI_GATEWAY_ID: 'test-gateway', CF_AI_TOKEN: 'cf-ai-token', CF_AIG_TOKEN: 'cf-inference-token', CF_API_TOKEN: 'cf-control-token' }, d1Databases: ['DB'], kvNamespaces: ['KV'], outboundService: outbound }));
  db = await mf.getD1Database('DB');
  for (const file of ['0001_initial.sql', '0002_ai_gateway_control_plane.sql', '0003_protocols_and_tags.sql', '0004_gateway_settings.sql', '0005_channel_auto_routes.sql', '0006_long_channel_timeout.sql', '0007_observability_cache.sql', '0008_responses_protocol.sql', '0009_remove_observability_cache.sql']) {
    const migration = await readFile(`migrations/${file}`, 'utf8');
    await db.batch(migration.split(';').filter(s => s.replace(/--[^\n]*/g, '').trim()).map(sql => db.prepare(sql)));
  }
});
beforeEach(async () => {
  calls = []; modelCalls = []; controlCalls = []; providers = new Map(); remoteLogs = []; controlFailure = 0; graphqlFailure = false; controlStatuses = [];
  logPageInfo = 'pages';
  modelResponse = () => MFResponse.json({ data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-a' }] });
  upstream = () => MFResponse.json(completion);
  await db.batch(['gateway_settings', 'upstream_error_traces', 'provider_profiles', 'request_logs', 'key_counters', 'api_keys', 'routes', 'models', 'channels'].map(table => db.prepare(`DELETE FROM ${table}`)));
  const response = await request('/api/auth/login', { body: { token: ADMIN } }); expect(response.status).toBe(200);
  cookie = response.headers.get('set-cookie')!.split(';')[0];
  await admin('/models', { id: 'test-model' });
  await route(await channel('Primary', 'primary.example.com'));
});
afterAll(async () => { await mf?.dispose(); });

describe('access control', () => {
  it('protects admin and inference endpoints', async () => {
    expect((await request('/api/providers')).status).toBe(401);
    expect((await request('/api/logs')).status).toBe(401);
    expect((await request('/v1/models')).status).toBe(401);
    expect((await request('/api/auth/login', { body: { token: 'wrong' } })).status).toBe(401);
  });
  it('rejects cross-origin mutations and invalid JSON', async () => {
    expect((await request('/api/providers', { admin: true, body: { name: 'attack' }, headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    const bad = await mf.dispatchFetch('https://edgegate.example/api/keys', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{' }); expect(bad.status).toBe(400);
  });
  it('uses secure HttpOnly cookies and invalidates logout', async () => {
    const login = await request('/api/auth/login', { body: { token: ADMIN } });
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) expect(login.headers.get('set-cookie')).toContain(flag);
    await admin('/auth/logout', {}, 'POST'); expect((await request('/api/channels', { admin: true })).status).toBe(401);
  });
  it('stores only client key hashes and masks secrets in lists', async () => {
    const created = await key(), record = await db.prepare('SELECT * FROM api_keys WHERE id = ?').bind(created.id).first();
    expect(JSON.stringify(record)).not.toContain(created.key);
    expect(JSON.stringify(await admin('/keys'))).not.toContain(created.key);
    expect(JSON.stringify(await admin('/channels'))).not.toContain('provider-secret');
  });
  it('rejects revoked and expired client keys immediately', async () => {
    const created = await key(); await admin(`/keys/${created.id}`, undefined, 'DELETE'); expect((await chat(created.key)).status).toBe(401);
    const expired = await key(); await db.prepare("UPDATE api_keys SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(expired.id).run(); expect((await chat(expired.key)).status).toBe(401); expect(calls).toHaveLength(0);
  });
  it('enforces model permissions and filters discovery', async () => {
    await admin('/models', { id: 'restricted-model' }); const created = await key({ allowed_models: ['test-model'] });
    expect(await (await request('/v1/models', { key: created.key })).json()).toMatchObject({ data: [{ id: 'test-model' }] });
    expect((await chat(created.key, { model: 'restricted-model' })).status).toBe(403);
  });
  it('enforces atomic quotas under concurrent requests', async () => {
    const created = await key({ rpm: 3 }), responses = await Promise.all(Array.from({ length: 8 }, () => chat(created.key)));
    expect(responses.filter(r => r.status === 200)).toHaveLength(3); expect(responses.filter(r => r.status === 429)).toHaveLength(5);
    expect(Number(responses.find(r => r.status === 429)!.headers.get('Retry-After'))).toBeGreaterThan(0); await Promise.all(responses.map(r => r.text())); expect(calls).toHaveLength(3);
  });
  it('enforces daily limits across minutes and resets next day', async () => {
    const created = await key({ daily_limit: 1 }); expect((await chat(created.key)).status).toBe(200);
    await db.prepare('UPDATE key_counters SET minute = minute - 1 WHERE key_id = ?').bind(created.id).run(); expect((await chat(created.key)).status).toBe(429);
    await db.prepare('UPDATE key_counters SET day = day - 1 WHERE key_id = ?').bind(created.id).run(); expect((await chat(created.key)).status).toBe(200);
  });
  it('rejects oversized inference bodies before reaching Cloudflare', async () => {
    expect((await chat((await key()).key, { messages: [{ role: 'user', content: 'a'.repeat(2 * 1024 * 1024) }] })).status).toBe(413); expect(calls).toHaveLength(0);
  });
});

describe('channel enable switches', () => {
  it('changes only channel state, works without CF, and immediately affects routing', async () => {
    const before = (await db.prepare("SELECT * FROM channels WHERE name = 'Primary'").first<Channel>())!;
    const routes = (await db.prepare('SELECT * FROM routes').all()).results;
    const profiles = (await db.prepare('SELECT * FROM provider_profiles').all()).results;
    const token = (await key()).key;
    controlCalls = []; controlFailure = 503;
    expect(await admin(`/channels/${before.id}`, { enabled: false }, 'PATCH')).toEqual({ enabled: false });
    expect(await admin(`/channels/${before.id}`, { enabled: false }, 'PATCH')).toEqual({ enabled: false });
    expect(await db.prepare('SELECT * FROM channels WHERE id = ?').bind(before.id).first()).toEqual({ ...before, enabled: 0 });
    expect(await visibleModels(token)).toEqual([]);
    expect((await chat(token)).status).toBe(503); expect(calls).toHaveLength(0);
    expect(await admin(`/channels/${before.id}`, { enabled: true }, 'PATCH')).toEqual({ enabled: true });
    expect(await visibleModels(token)).toEqual(['test-model']);
    const response = await chat(token); expect(response.status).toBe(200); await response.text();
    expect(await db.prepare('SELECT * FROM channels WHERE id = ?').bind(before.id).first()).toEqual(before);
    expect((await db.prepare('SELECT * FROM routes').all()).results).toEqual(routes);
    expect((await db.prepare('SELECT * FROM provider_profiles').all()).results).toEqual(profiles);
    expect(controlCalls).toHaveLength(0);
  });
  it('requires an explicit boolean and rejects unrelated fields and unauthorized changes', async () => {
    const channel = (await db.prepare("SELECT id FROM channels WHERE name = 'Primary'").first<{ id: string }>())!;
    const path = `/api/channels/${channel.id}`;
    for (const body of [{}, { enabled: 'false' }, { enabled: 0 }, { enabled: null }, { enabled: false, name: 'changed' }]) {
      expect((await request(path, { admin: true, method: 'PATCH', body })).status).toBe(400);
    }
    expect((await request(path, { method: 'PATCH', body: { enabled: false } })).status).toBe(401);
    expect((await request(path, { admin: true, method: 'PATCH', body: { enabled: false }, headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await request('/api/channels/missing', { admin: true, method: 'PATCH', body: { enabled: false } })).status).toBe(404);
    expect(await db.prepare('SELECT enabled FROM channels WHERE id = ?').bind(channel.id).first()).toEqual({ enabled: 1 });
  });
});

describe('Cloudflare custom providers and encrypted credentials', () => {
  it('creates a Cloudflare provider and encrypts its key in D1 without Secrets Store access', async () => {
    const providerCall = controlCalls.find(c => c.url.endsWith('/custom-providers'))!;
    expect(providerCall.body).toMatchObject({ name: 'Primary', slug: 'primary', base_url: 'https://primary.example.com', enable: true });
    expect(providerCall.headers.authorization).toBe('Bearer cf-control-token');
    expect(controlCalls.some(c => /secrets_store|provider_configs/.test(c.url))).toBe(false);
    expect(JSON.stringify(controlCalls)).not.toContain('provider-secret');
    const local = (await db.prepare('SELECT * FROM channels LIMIT 1').first<Channel>())!;
    expect(local).toMatchObject({ byok_alias: '', provider_slug: 'primary', gateway_path: 'v1/chat/completions' });
    expect(await decryptSecret(local.secret_encrypted!, ENCRYPTION, local.id)).toBe('provider-secret');
    await expect(decryptSecret(local.secret_encrypted!, ENCRYPTION, 'another-channel')).rejects.toThrow();
    expect(JSON.stringify(local)).not.toContain('provider-secret');
    const exposed = (await admin<Record<string, unknown>[]>('/channels'))[0];
    expect(exposed).toMatchObject({ has_secret: true, configured: true });
    expect(exposed).not.toHaveProperty('secret_encrypted');
  });
  it('links an existing account provider without creating or overwriting it', async () => {
    const existing = [...providers.values()][0], before = controlCalls.length;
    await admin('/channels', { name: 'Linked', kind: 'openai', provider_id: existing.id, gateway_path: 'v1/chat/completions', byok_alias: 'production' });
    expect(controlCalls.slice(before).filter(c => Object.keys(c.body).length)).toHaveLength(0);
    const linked = (await admin<Record<string, unknown>[]>('/channels')).find(c => c.name === 'Linked');
    expect(linked).toMatchObject({ provider_slug: 'primary', byok_alias: 'production' });
    expect(linked).not.toHaveProperty('secret_encrypted');
  });
  it('lists providers with pagination and strips sensitive remote fields', async () => {
    const existing = [...providers.values()][0]; existing.headers = 'Authorization: Bearer private-provider-header';
    const result = await admin<{ data: Provider[]; total: number }>('/providers?page=1');
    expect(result.total).toBe(1); expect(result.data[0]).not.toHaveProperty('headers');
    expect(JSON.stringify(result)).not.toContain('private-provider-header');
  });
  it('updates account provider metadata but rejects redirecting its credentials', async () => {
    const existing = [...providers.values()][0];
    await admin(`/providers/${existing.id}`, { name: 'Renamed', slug: existing.slug, base_url: existing.base_url, enable: false }, 'PATCH');
    expect(providers.get(existing.id)).toMatchObject({ name: 'Renamed', enable: false });
    expect((await request(`/api/providers/${existing.id}`, { method: 'PATCH', admin: true, body: { name: 'Attack', slug: existing.slug, base_url: 'https://attacker.example.com' } })).status).toBe(400);
  });
  it('keeps shared Cloudflare providers when removing local channels', async () => {
    const list = await admin<{ id: string; provider_id: string }[]>('/channels'), current = list[0];
    expect((await request(`/api/providers/${current.provider_id}`, { method: 'DELETE', admin: true })).status).toBe(409);
    await admin(`/channels/${current.id}`, undefined, 'DELETE'); expect(providers.has(current.provider_id)).toBe(true);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM routes').first()).toMatchObject({ n: 0 });
    await admin(`/providers/${current.provider_id}`, undefined, 'DELETE'); expect(providers.has(current.provider_id)).toBe(false);
  });
  it('never resumes old direct channels until linked to AI Gateway', async () => {
    await db.prepare('UPDATE channels SET provider_id = NULL, provider_slug = NULL, byok_alias = ?').bind('').run();
    expect((await chat((await key()).key)).status).toBe(503); expect(calls).toHaveLength(0);
  });
  it('retains a legacy encrypted key when linking the same destination to AI Gateway', async () => {
    const current = await db.prepare('SELECT * FROM channels LIMIT 1').first<{ id: string; provider_id: string }>();
    const encrypted = await encryptSecret('legacy-secret', ENCRYPTION, current!.id);
    await db.prepare('UPDATE channels SET provider_id = NULL, provider_slug = NULL, byok_alias = ?, base_url = ?, secret_encrypted = ? WHERE id = ?').bind('', 'https://primary.example.com/v1', encrypted, current!.id).run();
    await admin(`/channels/${current!.id}`, { name: 'Migrated', kind: 'openai', provider_id: current!.provider_id, gateway_path: 'v1/chat/completions' }, 'PUT');
    expect(await db.prepare('SELECT secret_encrypted FROM channels WHERE id = ?').bind(current!.id).first()).toMatchObject({ secret_encrypted: encrypted });
    expect((await chat((await key()).key)).status).toBe(200);
    expect(calls[0].headers.authorization).toBe('Bearer legacy-secret');
    expect(controlCalls.some(c => /secrets_store|provider_configs/.test(c.url))).toBe(false);
  });
  it('surfaces Cloudflare permission failures without saving a misleading local channel', async () => {
    controlFailure = 403;
    const response = await request('/api/channels', { admin: true, body: { name: 'Denied', kind: 'openai', provider_slug: 'denied', base_url: 'https://denied.example.com', secret: 'secret' } });
    expect(response.status).toBe(502); const data = await response.text(); expect(data).toContain('cloudflare_permission_denied'); expect(data).not.toContain('sensitive Cloudflare response');
    expect(await db.prepare("SELECT COUNT(*) AS n FROM channels WHERE name = 'Denied'").first()).toMatchObject({ n: 0 });
  });
  it('preserves encrypted keys on edits and rotates them without returning either key', async () => {
    const current = (await db.prepare('SELECT * FROM channels LIMIT 1').first<Channel>())!;
    await admin(`/channels/${current.id}`, { name: 'Renamed', kind: 'openai', provider_id: current.provider_id, credential_mode: 'local' }, 'PUT');
    expect(await db.prepare('SELECT secret_encrypted FROM channels WHERE id = ?').bind(current.id).first()).toMatchObject({ secret_encrypted: current.secret_encrypted });
    await admin(`/channels/${current.id}`, { name: 'Rotated', kind: 'openai', provider_id: current.provider_id, secret: 'new-provider-key' }, 'PUT');
    const rotated = (await db.prepare('SELECT * FROM channels WHERE id = ?').bind(current.id).first<Channel>())!;
    expect(rotated.secret_encrypted).not.toBe(current.secret_encrypted);
    expect(await decryptSecret(rotated.secret_encrypted!, ENCRYPTION, current.id)).toBe('new-provider-key');
    expect(JSON.stringify(await admin('/channels'))).not.toMatch(/provider-secret|new-provider-key|secret_encrypted/);
    expect((await chat((await key()).key)).status).toBe(200);
    expect(calls[0].headers.authorization).toBe('Bearer new-provider-key');
  });
  it('keeps existing BYOK channels working and explicitly switches between credential modes', async () => {
    const current = (await db.prepare('SELECT * FROM channels LIMIT 1').first<Channel>())!;
    await admin(`/channels/${current.id}`, { name: 'BYOK', kind: 'openai', provider_id: current.provider_id, credential_mode: 'byok', byok_alias: 'production' }, 'PUT');
    expect(await db.prepare('SELECT secret_encrypted, byok_alias FROM channels WHERE id = ?').bind(current.id).first()).toEqual({ secret_encrypted: null, byok_alias: 'production' });
    // Older clients can edit metadata without submitting a credential mode.
    await admin(`/channels/${current.id}`, { name: 'BYOK renamed', kind: 'openai', provider_id: current.provider_id }, 'PUT');
    const token = (await key()).key;
    expect((await chat(token)).status).toBe(200);
    expect(calls[0].headers['cf-aig-byok-alias']).toBe('production');
    expect(calls[0].headers.authorization).toBeUndefined(); expect(calls[0].headers['x-api-key']).toBeUndefined();
    const missing = await request(`/api/channels/${current.id}`, { method: 'PUT', admin: true, body: { name: 'Local', kind: 'openai', provider_id: current.provider_id, credential_mode: 'local' } });
    expect(missing.status).toBe(400);
    await admin(`/channels/${current.id}`, { name: 'Local', kind: 'openai', provider_id: current.provider_id, credential_mode: 'local', secret: 'local-key' }, 'PUT');
    expect((await chat(token)).status).toBe(200);
    expect(calls[1].headers.authorization).toBe('Bearer local-key');
    expect(calls[1].headers['cf-aig-byok-alias']).toBeUndefined();
    expect(await db.prepare('SELECT byok_alias FROM channels WHERE id = ?').bind(current.id).first()).toEqual({ byok_alias: '' });
    expect(controlCalls.some(c => /secrets_store|provider_configs/.test(c.url))).toBe(false);
  });
  it.each(['provider', 'path', 'base_url', 'legacy'])('does not reuse a saved key after a %s destination change', async change => {
    const current = (await db.prepare('SELECT * FROM channels LIMIT 1').first<Channel>())!;
    const body = { name: 'Changed', kind: 'openai', provider_id: current.provider_id!, gateway_path: current.gateway_path };
    if (change === 'provider') {
      const other = { id: crypto.randomUUID(), name: 'Other', slug: 'other', base_url: current.base_url, enable: true };
      providers.set(other.id, other); body.provider_id = other.id;
    } else if (change === 'path') body.gateway_path = 'different/chat/completions';
    else if (change === 'base_url') providers.get(current.provider_id!)!.base_url = 'https://changed.example.com';
    else await db.prepare('UPDATE channels SET provider_id = NULL, provider_slug = NULL, base_url = ? WHERE id = ?').bind('https://other.example.com/v1', current.id).run();
    const response = await request(`/api/channels/${current.id}`, { method: 'PUT', admin: true, body });
    expect(response.status).toBe(400); expect(await response.text()).not.toContain('provider-secret');
    expect(await db.prepare('SELECT secret_encrypted FROM channels WHERE id = ?').bind(current.id).first()).toMatchObject({ secret_encrypted: current.secret_encrypted });
    expect(calls).toHaveLength(0);
  });
  it.each([undefined, 'invalid-base64', btoa('short')])('rejects new keys before Cloudflare writes with invalid encryption configuration %s', async encryption => {
    const before = controlCalls.length;
    const response = await worker.fetch(new Request('https://edgegate.example/api/channels', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Invalid encryption', kind: 'openai', provider_slug: 'invalid-encryption', base_url: 'https://invalid-encryption.example.com', secret: 'never-echo-this-key' }) }), {
      DB: db, KV: await mf.getKVNamespace('KV'), ADMIN_TOKEN: ADMIN, ENCRYPTION_KEY: encryption, CLOUDFLARE_ACCOUNT_ID: account, CF_API_TOKEN: 'cf-control-token',
    } as unknown as Env);
    expect(response.status).toBe(503); const message = await response.text();
    expect(message).toContain('encryption_setup_required'); expect(message).not.toContain('never-echo-this-key');
    expect(controlCalls).toHaveLength(before);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM channels WHERE name = 'Invalid encryption'").first()).toMatchObject({ n: 0 });
  });
  it('does not reinterpret a Cloudflare token override as a provider key when changing channel kind', async () => {
    const native = await admin<{ id: string }>('/channels', { name: 'Native', kind: 'cloudflare', secret: 'cf-override' });
    const response = await request(`/api/channels/${native.id}`, { method: 'PUT', admin: true, body: { name: 'Custom', kind: 'openai', provider_id: [...providers.values()][0].id } });
    expect(response.status).toBe(400);
    expect(await db.prepare('SELECT kind FROM channels WHERE id = ?').bind(native.id).first()).toEqual({ kind: 'cloudflare' });
  });
});

describe('AI Gateway inference', () => {
  it('routes only through custom provider endpoints and forwards correlation metadata', async () => {
    const created = await key(); const response = await chat(created.key, { tools: [{ type: 'function', function: { name: 'lookup' } }], response_format: { type: 'json_object' } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(completion);
    expect(calls[0].url).toBe(`https://gateway.ai.cloudflare.com/v1/${account}/test-gateway/custom-primary/v1/chat/completions`);
    expect(calls[0].headers['cf-aig-authorization']).toBe('Bearer cf-inference-token');
    expect(calls[0].headers['cf-aig-byok-alias']).toBeUndefined();
    expect(calls[0].headers.authorization).toBe('Bearer provider-secret');
    expect(calls[0].headers['cf-aig-collect-log']).toBeUndefined(); expect(calls[0].headers['cf-aig-skip-cache']).toBeUndefined();
    expect(calls[0].body).toMatchObject({ model: 'upstream-test', response_format: { type: 'json_object' } });
    expect(JSON.parse(calls[0].headers['cf-aig-metadata'])).toMatchObject({ request_id: response.headers.get('X-Request-ID'), key_id: created.id, key_name: 'Test app', model_alias: 'test-model', attempt: '1' });
    expect(response.headers.get('cf-aig-log-id')).toBe('cf-log-1'); expect(JSON.stringify(calls)).not.toContain(created.key);
    expect(JSON.stringify(calls[0].body)).not.toContain('provider-secret'); expect(calls[0].headers['cf-aig-metadata']).not.toContain('provider-secret');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM request_logs').first()).toMatchObject({ n: 0 });
  });
  it('preserves provider path prefixes without adding a duplicate version', async () => {
    const existing = [...providers.values()][0]; existing.base_url = 'https://primary.example.com/api/v2';
    const current = (await admin<{ id: string }[]>('/channels'))[0];
    await admin(`/channels/${current.id}`, { name: 'Primary', kind: 'openai', provider_id: existing.id, gateway_path: 'chat/completions', byok_alias: 'default' }, 'PUT');
    expect((await chat((await key()).key)).status).toBe(200); expect(calls[0].url).toContain('/custom-primary/chat/completions');
  });
  it('fails over through AI Gateway and correlates both attempts', async () => {
    await route(await channel('Fallback', 'fallback.example.com'), 1, 'fallback-model');
    upstream = req => req.url.includes('custom-primary/') ? MFResponse.json({ error: 'private upstream message' }, { status: 429 }) : MFResponse.json(completion);
    const response = await chat((await key()).key); expect(response.status).toBe(200); expect(response.headers.get('X-Gateway-Attempts')).toBe('2');
    const meta = calls.map(c => JSON.parse(c.headers['cf-aig-metadata'])); expect(meta[0].request_id).toBe(meta[1].request_id); expect(meta.map(m => m.attempt)).toEqual(['1', '2']);
  });
  it('does not retry invalid parameters or follow redirects', async () => {
    upstream = () => MFResponse.json({ error: 'sensitive' }, { status: 400 }); const token = (await key()).key;
    const bad = await chat(token); expect(bad.status).toBe(400); expect(await bad.text()).not.toContain('sensitive'); expect(calls).toHaveLength(1);
    upstream = () => new MFResponse(null, { status: 302, headers: { Location: 'https://attacker.example.com' } }); expect((await chat(token)).status).toBe(502); expect(calls).toHaveLength(2);
  });
  it('aborts timed-out Cloudflare calls and fails over', async () => {
    await db.prepare('UPDATE channels SET timeout_ms = 1000').run(); await route(await channel('Fallback', 'fallback.example.com'), 1);
    upstream = async req => { if (req.url.includes('custom-primary/')) await new Promise(resolve => setTimeout(resolve, 1500)); return MFResponse.json(completion); };
    const response = await chat((await key()).key); expect(response.status).toBe(200); expect(response.headers.get('X-Gateway-Attempts')).toBe('2'); await response.text();
    await new Promise(resolve => setTimeout(resolve, 600));
  });
  it('preserves SSE bytes without implementing a local usage collector', async () => {
    const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: '你好🌏' } }] })}\r\n\r\ndata: ${JSON.stringify({ choices: [], usage: completion.usage })}\n\ndata: [DONE]\n\n`;
    upstream = () => { const bytes = new TextEncoder().encode(payload); let offset = 0; return new MFResponse(new NodeReadableStream({ pull(controller) { if (offset >= bytes.length) return controller.close(); controller.enqueue(bytes.slice(offset, offset + 7)); offset += 7; } }), { headers: { 'Content-Type': 'text/event-stream' } }); };
    const response = await chat((await key()).key, { stream: true, stream_options: { include_usage: false } }); expect(await response.text()).toBe(payload); expect(calls[0].body.stream_options).toEqual({ include_usage: false });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM request_logs').first()).toMatchObject({ n: 0 });
  });
  it('does not replay an SSE stream after output starts', async () => {
    await route(await channel('Fallback', 'fallback.example.com'), 1);
    upstream = () => new MFResponse('data: {"error":{"message":"upstream interrupted"}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    const response = await chat((await key()).key, { stream: true }); const text = await response.text(); expect(text).toContain('upstream_stream_error'); expect(text).not.toContain('upstream interrupted'); expect(calls).toHaveLength(1);
  });
  it('keeps Cloudflare native and dynamic routing integration', async () => {
    await db.prepare('DELETE FROM routes').run(); const cf = await admin<{ id: string }>('/channels', { name: 'CF', kind: 'cloudflare' }); await route(cf.id, 0, 'openai/gpt-4.1');
    const token = (await key()).key; expect((await chat(token)).status).toBe(200); expect(calls[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`); expect(calls[0].headers['cf-aig-gateway-id']).toBe('test-gateway');
    await db.prepare('DELETE FROM routes').run(); const dynamic = await admin<{ id: string }>('/channels', { name: 'Dynamic', kind: 'ai-gateway' }); await route(dynamic.id, 0, 'dynamic/smart-route'); expect((await chat(token)).status).toBe(200); expect(calls[1].url).toContain('/compat/chat/completions');
  });
  it('retains disabled route and model enforcement', async () => {
    const token = (await key()).key; await db.prepare('UPDATE routes SET enabled = 0').run(); expect((await chat(token)).status).toBe(503); await db.prepare('UPDATE routes SET enabled = 1').run(); await db.prepare('UPDATE models SET enabled = 0').run(); expect((await chat(token)).status).toBe(503); expect(calls).toHaveLength(0);
  });
});

describe('Cloudflare observability read directly', () => {
  it('keeps stable channel IDs without guessing from names', () => {
    expect(normalizeLog(logFixture({ metadata: JSON.stringify({ channel_id: 'channel-a', channel_name: 'Same name' }) }))).toMatchObject({ channel_id: 'channel-a', channel_name: 'Same name' });
    expect(normalizeLog(logFixture())).toMatchObject({ channel_id: null, channel_name: 'Primary' });
    expect(normalizeLog(logFixture({ metadata: '{invalid' }))).toMatchObject({ channel_id: null });
  });
  it('aggregates live channel availability by stable ID and reads again on refresh', async () => {
    const primary = (await db.prepare("SELECT id FROM channels WHERE name = 'Primary'").first<{ id: string }>())!.id;
    const fallback = await channel('Fallback', 'fallback.example.com');
    await db.prepare("UPDATE channels SET name = 'Same name'").run();
    const created_at = new Date(Date.now() - 60000).toISOString();
    const metadata = (channel_id: string) => JSON.stringify({ channel_id, channel_name: 'Old name', request_id: 'same-request' });
    remoteLogs = [
      logFixture({ id: 'a-ok', metadata: metadata(primary), created_at, status_code: undefined }),
      logFixture({ id: 'a-fail', metadata: metadata(primary), created_at, success: false, status_code: 503 }),
      logFixture({ id: 'a-cached', metadata: metadata(primary), created_at, cached: true }),
      logFixture({ id: 'b-ok', metadata: metadata(fallback), created_at }),
      logFixture({ id: 'unattributed', created_at }),
    ];
    controlCalls = [];
    const result = await admin<ChannelAvailabilityResponse>('/channels/availability');
    expect(result).toMatchObject({ source: 'cloudflare', coverage: 'complete', sampled_logs: 3 });
    const a = result.data.find(row => row.channel_id === primary)!;
    expect(a).toMatchObject({ requests: 2, successes: 1, rate: 0.5 });
    expect(a.buckets).toHaveLength(30);
    expect(a.buckets.filter(row => row.requests)).toEqual([expect.objectContaining({ requests: 2, successes: 1, rate: 0.5 })]);
    expect(result.data.find(row => row.channel_id === fallback)).toMatchObject({ requests: 1, successes: 1, rate: 1 });
    expect(controlCalls).toHaveLength(1);
    expect((await request('/api/channels/availability')).status).toBe(401);
    remoteLogs[1].success = true; remoteLogs[1].status_code = 200;
    expect((await admin<ChannelAvailabilityResponse>('/channels/availability')).data.find(row => row.channel_id === primary)).toMatchObject({ requests: 2, successes: 2, rate: 1 });
    expect(controlCalls).toHaveLength(2);
  });
  it('reads only the requested page directly and preserves metadata correlation', async () => {
    remoteLogs = Array.from({ length: 26 }, (_, i) => logFixture({ id: `remote-${i}`, created_at: new Date(Date.now() - i * 1000).toISOString() }));
    controlCalls = [];
    const result = await admin<{ data: Record<string, unknown>[]; total: number; has_more: boolean }>('/logs?page=2');
    expect(result.total).toBe(26); expect(result.has_more).toBe(false); expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ id: 'remote-25', request_id: 'edge-request', model: 'test-model', upstream_model: 'cloud-model', status: 200, key_name: 'Test app', source: 'cloudflare' });
    expect(controlCalls).toHaveLength(1);
    expect(Object.fromEntries(new URL(controlCalls[0].url).searchParams)).toEqual({ page: '2', per_page: '25', order_by: 'created_at', order_by_direction: 'desc', meta_info: 'true' });
    expect(result).not.toHaveProperty('storage'); expect(result).not.toHaveProperty('sync');
    remoteLogs[25].tokens_out = 900;
    expect(await admin('/logs?page=2')).toMatchObject({ data: [{ output_tokens: 900 }] });
    expect(controlCalls).toHaveLength(2);
  });
  it.each(['count', 'none'] as const)('paginates with %s metadata without inventing totals', async metadata => {
    logPageInfo = metadata;
    remoteLogs = Array.from({ length: 26 }, (_, i) => logFixture({ id: `metadata-${i}`, created_at: new Date(Date.now() - i * 1000).toISOString() }));
    expect(await admin('/logs')).toMatchObject({ total: metadata === 'count' ? 26 : null, has_more: true });
    expect(await admin('/logs?page=2')).toMatchObject({ total: metadata === 'count' ? 26 : null, has_more: false });
  });
  it('does not apply local retention or remote date windows to the live list', async () => {
    remoteLogs = [logFixture({ id: 'clock-ahead', created_at: new Date(Date.now() + 120000).toISOString() }),
      logFixture({ id: 'older', created_at: '2000-01-01T00:00:00.000Z' })];
    controlCalls = [];
    expect(await admin('/logs')).toMatchObject({ total: 2 });
    expect(await admin('/logs/older')).toMatchObject({ id: 'older' });
    const params = new URL(controlCalls[0].url).searchParams;
    expect(params.has('start_date')).toBe(false); expect(params.has('end_date')).toBe(false); expect(params.has('filters')).toBe(false);
  });
  it('delegates model/status/search filtering and totals to Cloudflare', async () => {
    remoteLogs = [logFixture(), logFixture({ id: 'failed', model: 'other-model', success: false, status_code: 500 })];
    controlCalls = [];
    expect(await admin('/logs?status=error&model=other-model&search=failed')).toMatchObject({ total: 1, data: [{ id: 'failed' }] });
    expect(Object.fromEntries(new URL(controlCalls[0].url).searchParams)).toMatchObject({ success: 'false', model: 'other-model', search: 'failed' });
  });
  it('reads fresh details without returning secret-bearing headers or request bodies', async () => {
    remoteLogs = [logFixture({ request_head: 'Authorization: secret' })];
    controlCalls = [];
    const detail = await admin(`/logs/${remoteLogs[0].id}`);
    expect(detail).toMatchObject({ id: remoteLogs[0].id, source: 'cloudflare' });
    expect(detail).not.toHaveProperty('request_head'); expect(detail).not.toHaveProperty('storage');
    expect(JSON.stringify(detail)).not.toContain('Authorization');
    remoteLogs[0].tokens_out = 999;
    expect(await admin(`/logs/${remoteLogs[0].id}`)).toMatchObject({ output_tokens: 999 });
    expect(controlCalls).toHaveLength(2);
    remoteLogs = [];
    expect((await request('/api/logs/cf-remote-log', { admin: true })).status).toBe(404);
  });
  it('does not fabricate missing status, tokens, or costs', async () => {
    remoteLogs = [logFixture({ status_code: undefined, tokens_in: null, tokens_out: null, cost: undefined, metadata: '{invalid' })];
    const result = await admin<{ data: Record<string, unknown>[] }>('/logs');
    expect(result.data[0]).toMatchObject({ status: null, input_tokens: null, output_tokens: null, cost_usd: null, key_name: '外部调用', model: 'cloud-model' });
  });
  it('fetches live GraphQL aggregates and schema on every request without KV caching', async () => {
    remoteLogs = [logFixture()]; controlCalls = [];
    const result = await admin('/stats?range=24h');
    expect(result).toMatchObject({ source: 'cloudflare', scope: 'gateway', summary: { requests: 12345, successes: 12300, input_tokens: 500000, output_tokens: 100000, cost_usd: 4.25, cache_hits: 1000 } });
    expect(result.window_end).toBeTruthy(); expect(result.window_start).toBeTruthy();
    expect(result).not.toHaveProperty('sync'); expect(result).not.toHaveProperty('storage');
    const query = String(controlCalls.find(call => String(call.body.query).includes('aiGatewayRequestsAdaptiveGroups'))?.body.query);
    expect(query).toContain('gateway: "test-gateway"'); expect(query).toContain(`accountTag: "${account}"`);
    expect(controlCalls).toHaveLength(2);
    await admin('/stats?range=7d'); expect(controlCalls).toHaveLength(4);
    expect(controlCalls.filter(call => String(call.body.query).includes('__type'))).toHaveLength(2);
    expect((await (await mf.getKVNamespace('KV')).list({ prefix: 'cf:analytics-schema:' })).keys).toEqual([]);
  });
  it.each(['/logs', '/logs/cf-remote-log', '/stats', '/channels/availability'])('retries 5xx twice for %s, then reports failure instead of stale data', async path => {
    remoteLogs = [logFixture()]; await admin(path); controlCalls = []; controlStatuses = [502, 503];
    await admin(path);
    expect(controlCalls).toHaveLength(path === '/stats' ? 4 : 3);
    controlCalls = []; controlFailure = 503;
    const response = await request(`/api${path}`, { admin: true });
    expect(response.status).toBe(502); expect(controlCalls).toHaveLength(3);
    const result = await response.json(); expect(result).toMatchObject({ error: { code: 'cloudflare_api_error', message: expect.stringContaining('已重试 2 次') } });
    expect(JSON.stringify(result)).not.toContain('sensitive Cloudflare response');
  });
  it('reports GraphQL errors without a fake zero-traffic response or extra retries', async () => {
    graphqlFailure = true; controlCalls = [];
    const response = await request('/api/stats', { admin: true });
    expect(response.status).toBe(502); expect(controlCalls).toHaveLength(1);
    expect(await response.json()).toMatchObject({ error: { code: 'cloudflare_analytics_error' } });
  });
  it('removes sync endpoints and cache tables; scheduled cleanup never fetches Cloudflare', async () => {
    for (const [path, method] of [['/observability', 'GET'], ['/observability/sync', 'POST'], ['/config/observability', 'PUT']]) {
      expect((await request(`/api${path}`, { admin: true, method })).status).toBe(404);
    }
    expect((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'observability_%'").all()).results).toEqual([]);
    await db.prepare("INSERT INTO request_logs (id,key_id,model,status,latency_ms) VALUES ('legacy','old','old-model',200,3)").run();
    controlCalls = [];
    const result = await (await mf.getWorker()).scheduled({ cron: '15 3 * * *', scheduledTime: new Date('2026-09-13T03:15:00Z') });
    expect(result.outcome).toBe('ok'); expect(controlCalls).toHaveLength(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM request_logs').first()).toEqual({ n: 1 });
  });
});

describe('Playground tag routing', () => {
  const playground = (query: string, model = 'shared') => request(`/api/playground${query}`, { admin: true, body: { model, messages: [{ role: 'user', content: 'test' }], stream: false } });
  it('routes shared models within the selected tag, including untagged and multi-tag channels', async () => {
    const a = await catalog('Pga', 'openai', ['AA', 'AB'], ['shared', 'a-only']);
    const b = await catalog('Pgb', 'openai', ['BB'], ['shared']);
    const untagged = await catalog('Pgu', 'openai', [], ['shared']);
    await db.prepare('UPDATE routes SET priority = 10 WHERE channel_id = ?').bind(a.channelId).run();
    for (const [query, id] of [['?tag=AA', a.channelId], ['?tag=AB', a.channelId], ['?tag=BB', b.channelId], ['?untagged=1', untagged.channelId]]) {
      calls = []; const response = await playground(query); expect(response.status).toBe(200); await response.text();
      expect(calls).toHaveLength(1); expect(JSON.parse(calls[0].headers['cf-aig-metadata']).channel_id).toBe(id);
      expect(calls[0].body).not.toHaveProperty('tag'); expect(calls[0].body).not.toHaveProperty('untagged');
    }
    calls = [];
    expect((await playground('?tag=BB', 'a-only')).status).toBe(503);
    expect((await playground('?tag=removed')).status).toBe(503); expect(calls).toHaveLength(0);
  });
  it('keeps every retry within the tag even when another tag has healthy routes', async () => {
    const a = await catalog('Pgretrya', 'openai', ['AA'], ['shared']);
    const a2 = await catalog('Pgretryb', 'openai', ['AA'], ['shared']);
    await catalog('Pgretryoutside', 'openai', ['BB'], ['shared']);
    await runtime({ same_channel_retries: 1, cross_channel_retries: 3 });
    upstream = req => req.url.includes('custom-pgretryoutside/') ? MFResponse.json(completion) : MFResponse.json({ error: 'busy' }, { status: 503 });
    expect((await playground('?tag=AA')).status).toBe(502);
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map(call => JSON.parse(call.headers['cf-aig-metadata']).channel_id))).toEqual(new Set([a.channelId, a2.channelId]));
  });
  it('validates admin scopes without changing public API key permissions', async () => {
    const a = await catalog('Pgkeya', 'openai', ['AA'], ['shared']);
    await catalog('Pgkeyb', 'openai', ['BB'], ['shared']);
    for (const query of ['?tag=', '?tag=AA&untagged=1', '?untagged=0', `?tag=${'a'.repeat(41)}`]) {
      expect((await playground(query)).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
    expect((await request('/api/playground?tag=AA', { body: { model: 'shared', messages: [{ role: 'user', content: 'test' }] } })).status).toBe(401);
    const token = (await key({ allowed_tags: ['AA'] })).key;
    const result = await request('/v1/chat/completions?tag=BB&untagged=1', { key: token, body: { model: 'shared', messages: [{ role: 'user', content: 'test' }] } });
    expect(result.status).toBe(200); await result.text();
    expect(JSON.parse(calls[0].headers['cf-aig-metadata']).channel_id).toBe(a.channelId);
  });
});

describe('local crypto and routing rules', () => {
  it('binds encrypted credentials to a channel', async () => { const value = await encryptSecret('secret', ENCRYPTION, 'a'); expect(await decryptSecret(value, ENCRYPTION, 'a')).toBe('secret'); await expect(decryptSecret(value, ENCRYPTION, 'b')).rejects.toThrow(); });
  it('orders priorities and weights without duplicate attempts', () => { const values = [{ id: 'a', priority: 0, weight: 1 }, { id: 'b', priority: 0, weight: 9 }, { id: 'c', priority: 1, weight: 1000 }] as Candidate[]; expect(orderCandidates(values, () => 0.5).map(c => c.id)).toEqual(['b', 'a', 'c']); });
  it.each(['http://api.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://a.local', 'https://user:pass@api.example.com', 'https://api.example.com:8443', 'https://api.example.com?secret=x'])('rejects unsafe provider URL %s', url => { expect(() => safeBaseUrl(url)).toThrow(); });
});

async function catalog(name: string, protocol: Protocol, tags: string[], models: string[]) {
  const created = await admin<{ id: string }>('/channels', { name, kind: 'openai', provider_slug: name.toLowerCase(), base_url: `https://${name.toLowerCase()}.example.com`, secret: `${name.toLowerCase()}-provider-key`, protocol, tags, models });
  const local = await db.prepare('SELECT provider_id FROM channels WHERE id = ?').bind(created.id).first<{ provider_id: string }>();
  return { channelId: created.id, provider: providers.get(local!.provider_id)! };
}
async function editProvider(provider: Provider, update: Record<string, unknown>) {
  return admin(`/providers/${provider.id}`, { name: provider.name, slug: provider.slug, base_url: provider.base_url, enable: provider.enable, ...update }, 'PATCH');
}
async function visibleModels(token: string) {
  const response = await request('/v1/models', { key: token }); expect(response.status).toBe(200);
  return ((await response.json()) as { data: { id: string }[] }).data.map(m => m.id);
}
const anthropicCompletion = { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: '你好，世界' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 7, output_tokens: 11 } };
const messages = (token: string, extra = {}, headers = {}) => request('/v1/messages', { headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01', ...headers }, body: { model: 'test-model', messages: [{ role: 'user', content: '你好' }], max_tokens: 100, ...extra } });

describe('tag-scoped model and route administration', () => {
  async function sharedChannels() {
    const a = await catalog('ScopedA', 'openai', ['AA'], ['claude-opus-5']);
    const b = await catalog('ScopedB', 'openai', ['BB'], ['claude-opus-5']);
    const models = await admin<(Model & { routes: Route[] })[]>('/models');
    const model = models.find(model => model.id === 'claude-opus-5')!;
    return { a, b, model, routeA: model.routes.find(route => route.channel_id === a.channelId)!, routeB: model.routes.find(route => route.channel_id === b.channelId)! };
  }
  it('scopes both the model directory and routes, retaining disabled channels and routes', async () => {
    const { a, routeA, routeB } = await sharedChannels();
    await db.prepare('UPDATE channels SET enabled = 0 WHERE id = ?').bind(a.channelId).run();
    await db.prepare('UPDATE routes SET enabled = 0 WHERE id = ?').bind(routeA.id).run();
    expect(await admin('/models?tag=AA')).toMatchObject([{ id: 'claude-opus-5', routes: [{ id: routeA.id, enabled: 0 }] }]);
    expect((await admin<(Model & { routes: Route[] })[]>('/models?tag=AA'))[0].routes).toHaveLength(1);
    expect(await admin('/models?tag=BB')).toMatchObject([{ id: 'claude-opus-5', routes: [{ id: routeB.id }] }]);
    expect(await admin('/models?tag=aa')).toEqual([]);
    expect(await admin('/models?tag=deleted')).toEqual([]);
    expect((await admin<Model[]>('/models?untagged=1')).map(model => model.id)).toEqual(['test-model']);
  });
  it('reuses a global model when adding a scoped route and leaves other tags unchanged', async () => {
    const { a, model, routeB } = await sharedChannels();
    await admin(`/models/${model.id}`, { description: 'shared description', enabled: false }, 'PUT');
    await admin('/routes?tag=AA', { model_id: model.id, channel_id: a.channelId, upstream_model: 'opus-alias', weight: 3 });
    expect(await admin('/models?tag=BB')).toMatchObject([{ id: model.id, description: 'shared description', enabled: 0, routes: [routeB] }]);
    expect((await admin<(Model & { routes: Route[] })[]>('/models?tag=AA'))[0].routes).toHaveLength(2);
  });
  it('rejects source and destination routes outside the selected tag, including stale tags', async () => {
    const { a, b, model, routeA, routeB } = await sharedChannels();
    const data = { model_id: model.id, channel_id: a.channelId, upstream_model: 'changed' };
    expect((await request('/api/routes?tag=AA', { admin: true, body: { ...data, channel_id: b.channelId } })).status).toBe(400);
    expect((await request(`/api/routes/${routeB.id}?tag=AA`, { admin: true, method: 'PUT', body: data })).status).toBe(409);
    expect((await request(`/api/routes/${routeA.id}?tag=AA`, { admin: true, method: 'PUT', body: { ...data, channel_id: b.channelId } })).status).toBe(400);
    expect((await request(`/api/routes/${routeB.id}?tag=AA`, { admin: true, method: 'DELETE' })).status).toBe(409);
    await editProvider(a.provider, { tags: ['CC'] });
    expect((await request(`/api/routes/${routeA.id}?tag=AA`, { admin: true, method: 'PUT', body: data })).status).toBe(409);
    expect((await request(`/api/routes/${routeA.id}?tag=AA`, { admin: true, method: 'DELETE' })).status).toBe(409);
    expect(await db.prepare('SELECT * FROM routes WHERE id = ?').bind(routeB.id).first()).toMatchObject(routeB);
  });
  it('keeps global deletion and disabling outside tag scope and preserves BB inference after AA route removal', async () => {
    const { model, routeA, routeB } = await sharedChannels();
    expect((await request(`/api/models/${model.id}?tag=AA`, { admin: true, method: 'PUT', body: { enabled: false } })).status).toBe(400);
    expect((await request(`/api/models/${model.id}?tag=AA`, { admin: true, method: 'DELETE' })).status).toBe(400);
    await admin(`/routes/${routeA.id}?tag=AA`, undefined, 'DELETE');
    expect(await admin('/models?tag=AA')).toEqual([]);
    expect(await admin('/models?tag=BB')).toMatchObject([{ id: model.id, enabled: 1, routes: [routeB] }]);
    const token = (await key({ allowed_tags: ['BB'] })).key;
    expect((await chat(token, { model: model.id })).status).toBe(200);
    expect(calls).toHaveLength(1); expect(calls[0].url).toContain('/custom-scopedb/');
  });
  it('shows a multi-tag channel in both scopes without duplicating or forking its route', async () => {
    const a = await catalog('SharedTags', 'openai', ['AA', 'BB'], ['claude-opus-5']);
    const aa = await admin<(Model & { routes: Route[] })[]>('/models?tag=AA');
    const route = aa[0].routes[0];
    await admin(`/routes/${route.id}?tag=AA`, { model_id: 'claude-opus-5', channel_id: a.channelId, upstream_model: route.upstream_model, weight: 7, enabled: false }, 'PUT');
    const bb = await admin<(Model & { routes: Route[] })[]>('/models?tag=BB');
    expect(bb[0].routes).toHaveLength(1); expect(bb[0].routes[0]).toMatchObject({ id: route.id, weight: 7, enabled: 0 });
  });
});

describe('provider tags and the union of accessible models', () => {
  it('unions Sonnet from A and Opus from B for one tagged API key', async () => {
    await catalog('A', 'anthropic', ['claude'], ['claude-sonnet-4-5']);
    await catalog('B', 'openai', ['claude'], ['claude-opus-4-6']);
    await catalog('C', 'openai', ['private'], ['private-model']);
    const token = (await key({ allowed_tags: ['claude'] })).key;
    expect(await visibleModels(token)).toEqual(['claude-opus-4-6', 'claude-sonnet-4-5']);
    expect(await admin('/tags')).toEqual(['claude', 'private']);
    expect((await admin<{ allowed_tags: string[] }[]>('/keys'))[0].allowed_tags).toEqual(['claude']);
    expect(controlCalls.filter(c => c.url.endsWith('/custom-providers')).every(c => !('tags' in c.body) && !('protocol' in c.body) && !('models' in c.body))).toBe(true);
  });
  it('deduplicates shared models and treats multiple selected tags as OR', async () => {
    await catalog('A', 'anthropic', ['prod'], ['shared', 'only-a']);
    await catalog('B', 'openai', ['dev'], ['shared', 'only-b']);
    expect(await visibleModels((await key({ allowed_tags: ['prod', 'dev'] })).key)).toEqual(['only-a', 'only-b', 'shared']);
  });
  it('intersects model allowlists with tag permissions', async () => {
    await catalog('A', 'openai', ['prod'], ['allowed', 'other']);
    const token = (await key({ allowed_tags: ['prod'], allowed_models: ['allowed', 'test-model'] })).key;
    expect(await visibleModels(token)).toEqual(['allowed']);
    expect((await chat(token)).status).toBe(403);
    expect((await chat(token, { model: 'other' })).status).toBe(403); expect(calls).toHaveLength(0);
  });
  it('filters inference and fallback before route priorities, and never escapes the allowed tags', async () => {
    await catalog('Allowed', 'openai', ['public'], ['test-model']);
    const token = (await key({ allowed_tags: ['public'] })).key;
    // The existing untagged Primary route is available and otherwise has equal priority.
    upstream = () => MFResponse.json({ error: 'unavailable' }, { status: 503 });
    expect((await chat(token)).status).toBe(502);
    expect(calls).toHaveLength(1); expect(calls[0].url).toContain('/custom-allowed/');
    calls = [];
    expect((await messages(token)).status).toBe(502);
    expect(calls).toHaveLength(1); expect(calls[0].url).toContain('/custom-allowed/');
  });
  it('does not bypass tags by sending their names or another provider in the request', async () => {
    await catalog('A', 'openai', ['public'], ['public-model']);
    const token = (await key({ allowed_tags: ['public'] })).key;
    expect((await chat(token, { tags: [], allowed_tags: [], provider: 'primary' })).status).toBe(403);
    const response = await messages(token); expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'permission_error' } }); expect(calls).toHaveLength(0);
  });
  it('reflects tag edits immediately without changing the key and preserves omitted profile fields', async () => {
    const a = await catalog('A', 'anthropic', ['public'], ['sonnet']);
    const token = (await key({ allowed_tags: ['public'] })).key;
    expect(await visibleModels(token)).toEqual(['sonnet']);
    await editProvider(a.provider, { tags: ['private'] });
    expect(await visibleModels(token)).toEqual([]);
    expect((await chat(token, { model: 'sonnet' })).status).toBe(403);
    await editProvider(a.provider, { tags: ['public'] });
    expect(await visibleModels(token)).toEqual(['sonnet']);
    expect(await db.prepare('SELECT protocol FROM provider_profiles WHERE provider_id = ?').bind(a.provider.id).first()).toMatchObject({ protocol: 'anthropic' });
  });
  it('excludes disabled channels and routes while unrestricted keys retain access to untagged providers', async () => {
    const a = await catalog('A', 'openai', ['public'], ['sonnet']);
    const unrestricted = (await key()).key, scoped = (await key({ allowed_tags: ['public'] })).key;
    expect(await visibleModels(unrestricted)).toEqual(['sonnet', 'test-model']);
    await db.prepare('UPDATE channels SET enabled = 0 WHERE id = ?').bind(a.channelId).run();
    expect(await visibleModels(scoped)).toEqual([]);
    expect(await visibleModels(unrestricted)).toEqual(['test-model']);
    await db.prepare('UPDATE channels SET enabled = 1 WHERE id = ?').bind(a.channelId).run();
    await db.prepare('UPDATE routes SET enabled = 0 WHERE channel_id = ?').bind(a.channelId).run();
    expect(await visibleModels(scoped)).toEqual([]);
  });
  it('reconciles provider catalogs without deleting manual model aliases', async () => {
    const a = await catalog('A', 'openai', ['public'], ['sonnet']);
    await admin('/models', { id: 'my-alias' });
    await admin('/routes', { model_id: 'my-alias', channel_id: a.channelId, upstream_model: 'sonnet' });
    const token = (await key({ allowed_tags: ['public'] })).key;
    await editProvider(a.provider, { models: ['opus'] });
    expect(await visibleModels(token)).toEqual(['my-alias', 'opus']);
    const linked = await admin<{ id: string }>('/channels', { name: 'Another credential', kind: 'openai', provider_id: a.provider.id, byok_alias: 'second' });
    expect(await db.prepare('SELECT model_id FROM routes WHERE channel_id = ?').bind(linked.id).all()).toMatchObject({ results: [{ model_id: 'opus' }] });
  });
  it('creates provider metadata before a channel and publishes its catalog when linked', async () => {
    const provider = await admin<Provider>('/providers', { name: 'Profile', slug: 'profile', base_url: 'https://profile.example.com/v1', protocol: 'anthropic', tags: ['生产', '生产'], models: ['sonnet'] });
    const token = (await key({ allowed_tags: ['生产'] })).key;
    expect(await visibleModels(token)).toEqual([]);
    const local = await admin<{ id: string }>('/channels', { name: 'Profile', kind: 'openai', provider_id: provider.id, byok_alias: 'default' });
    expect(await visibleModels(token)).toEqual(['sonnet']);
    expect(await db.prepare('SELECT gateway_path FROM channels WHERE id = ?').bind(local.id).first()).toMatchObject({ gateway_path: 'messages' });
    expect((await admin<{ data: { id: string; protocol: string; tags: string[] }[] }>('/providers')).data.find(p => p.id === provider.id)).toMatchObject({ protocol: 'anthropic', tags: ['生产'] });
  });
  it('rejects nonexistent or malformed tag selections', async () => {
    expect((await request('/api/keys', { admin: true, body: { name: 'Invalid', allowed_tags: ['not-created'] } })).status).toBe(400);
    expect((await request('/api/providers', { admin: true, body: { name: 'Invalid', slug: 'invalid', base_url: 'https://example.com', tags: ['a,b'] } })).status).toBe(400);
  });
});

describe('dual API endpoints through Cloudflare AI Gateway', () => {
  it('converts OpenAI requests and responses for an Anthropic custom provider', async () => {
    await catalog('Anthropic', 'anthropic', ['claude'], ['claude-sonnet-4-5']);
    upstream = () => MFResponse.json(anthropicCompletion);
    const token = (await key({ allowed_tags: ['claude'] })).key;
    const response = await chat(token, { model: 'claude-sonnet-4-5', messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '你好' }], max_tokens: 1024 });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ object: 'chat.completion', choices: [{ message: { role: 'assistant', content: '你好，世界' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 11 } });
    expect(calls[0].url).toBe(`https://gateway.ai.cloudflare.com/v1/${account}/test-gateway/custom-anthropic/v1/messages`);
    expect(calls[0].body).toMatchObject({ max_tokens: 1024, system: [{ type: 'text', text: '规则' }], messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] });
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0].headers['x-api-key']).toBe('anthropic-provider-key');
    expect(calls[0].headers.authorization).toBeUndefined(); expect(calls[0].headers['cf-aig-byok-alias']).toBeUndefined();
    expect(calls[0].headers['cf-aig-authorization']).toBe('Bearer cf-inference-token');
    expect(JSON.stringify(calls)).not.toContain(token);
  });
  it.each(['anthropic', 'responses'] as const)('omits unsupported Chat options for %s while preserving mapped input and supported tools', async protocol => {
    await catalog('OptionalParams', protocol, ['optional-params'], ['shared']);
    upstream = () => MFResponse.json(protocol === 'anthropic' ? anthropicCompletion : responsesCompletion);
    const parameters = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
    const response = await chat((await key({ allowed_tags: ['optional-params'] })).key, {
      model: 'shared', frequency_penalty: 0.6, presence_penalty: 0.3, seed: 42, logprobs: true, top_logprobs: 3, n: 3,
      vendor_option: { enabled: true }, temperature: 1.8, max_completion_tokens: 512, top_p: 0.85, stop: ['END'],
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: '规则' }, { role: 'user', content: [{ type: 'text', text: '查天气', cache_control: { type: 'ephemeral' } }] }],
      tools: [{ type: 'function', function: { name: 'weather', parameters, strict: true } }, { type: 'web_search' }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ object: 'chat.completion', choices: [{ message: { content: '你好，世界' } }] });
    expect(calls).toHaveLength(1);
    const body = calls[0].body;
    for (const field of ['frequency_penalty', 'presence_penalty', 'seed', 'logprobs', 'top_logprobs', 'n', 'vendor_option']) expect(body).not.toHaveProperty(field);
    expect(body.top_p).toBe(0.85); expect(JSON.stringify(body)).not.toContain('cache_control');
    if (protocol === 'anthropic') {
      expect(body).toMatchObject({ max_tokens: 512, stop_sequences: ['END'], system: [{ type: 'text', text: '规则' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: '查天气' }] }], tools: [{ name: 'weather', input_schema: parameters }] });
      expect(body).not.toHaveProperty('temperature'); expect(body).not.toHaveProperty('response_format');
      expect(body.tools).toHaveLength(1); expect(body.tools).toEqual([{ name: 'weather', input_schema: parameters }]);
    } else {
      expect(body).toMatchObject({ max_output_tokens: 512, temperature: 1.8, text: { format: { type: 'json_object' } },
        input: [{ role: 'system', content: [{ type: 'input_text', text: '规则' }] }, { role: 'user', content: [{ type: 'input_text', text: '查天气' }] }],
        tools: [{ type: 'function', name: 'weather', parameters, strict: true }] });
      expect(body.tools).toHaveLength(1); expect(body).not.toHaveProperty('stop');
    }
  });
  it('accepts x-api-key on /v1/messages and converts requests to OpenAI', async () => {
    const response = await messages((await key()).key, { system: '规则', stop_sequences: ['END'] });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'text', text: '你好，世界' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 11 } });
    expect(calls[0].url).toContain('/custom-primary/v1/chat/completions');
    expect(calls[0].body).toMatchObject({ messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '你好' }], max_tokens: 100, stop: ['END'] });
    expect(calls[0].headers['x-api-key']).toBeUndefined(); expect(calls[0].headers['anthropic-version']).toBeUndefined();
    expect(calls[0].headers.authorization).toBe('Bearer provider-secret');
  });
  it('ignores Anthropic thinking options and cache hints when converting ordinary text to Chat', async () => {
    const response = await messages((await key()).key, { thinking: { type: 'enabled', budget_tokens: 1024 }, top_k: 10,
      system: [{ type: 'text', text: '规则', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好', cache_control: { type: 'ephemeral' } }] }],
    });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ type: 'message', content: [{ type: 'text', text: '你好，世界' }] });
    expect(calls).toHaveLength(1); expect(calls[0].body).not.toHaveProperty('thinking'); expect(calls[0].body).not.toHaveProperty('top_k');
    expect(JSON.stringify(calls[0].body.messages)).not.toContain('cache_control');
    expect(calls[0].body.messages).toEqual([{ role: 'system', content: [{ type: 'text', text: '规则' }] }, { role: 'user', content: [{ type: 'text', text: '你好' }] }]);
  });
  it('keeps Anthropic-native extensions and beta headers on matching routes', async () => {
    await catalog('Anthropic', 'anthropic', ['claude'], ['sonnet']);
    upstream = () => MFResponse.json(anthropicCompletion);
    const response = await messages((await key({ allowed_tags: ['claude'] })).key, { model: 'sonnet', thinking: { type: 'enabled', budget_tokens: 1024 } }, { 'anthropic-beta': 'test-beta' });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(anthropicCompletion);
    expect(calls[0].body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 }); expect(calls[0].headers['anthropic-beta']).toBe('test-beta');
  });
  it('re-converts the original request for a different fallback protocol', async () => {
    const a = await catalog('Anthropic', 'anthropic', ['mixed'], ['shared']);
    const b = await catalog('Compatible', 'openai', ['mixed'], ['shared']);
    await db.prepare('UPDATE routes SET priority = 1 WHERE channel_id = ?').bind(b.channelId).run();
    upstream = req => req.url.includes('/custom-anthropic/') ? MFResponse.json({ error: 'busy' }, { status: 503 }) : MFResponse.json(completion);
    const response = await chat((await key({ allowed_tags: ['mixed'] })).key, { model: 'shared', frequency_penalty: 0.6, presence_penalty: 0.3, n: 3, temperature: 1.8,
      vendor_option: { enabled: true }, messages: [{ role: 'system', content: 'rule' }, { role: 'user', content: 'question' }] });
    expect(response.status).toBe(200); expect(calls).toHaveLength(2);
    expect(calls[0].body.system).toEqual([{ type: 'text', text: 'rule' }]);
    expect(calls[1].body.messages).toEqual([{ role: 'system', content: 'rule' }, { role: 'user', content: 'question' }]);
    expect(calls[1].body).not.toHaveProperty('system'); expect(response.headers.get('X-Gateway-Attempts')).toBe('2');
    for (const field of ['frequency_penalty', 'presence_penalty', 'n', 'temperature', 'vendor_option']) expect(calls[0].body).not.toHaveProperty(field);
    expect(calls[1].body).toMatchObject({ frequency_penalty: 0.6, presence_penalty: 0.3, n: 3, temperature: 1.8, vendor_option: { enabled: true } });
    expect(calls[0].headers['x-api-key']).toBe('anthropic-provider-key'); expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[1].headers.authorization).toBe('Bearer compatible-provider-key'); expect(calls[1].headers['x-api-key']).toBeUndefined();
    expect(a.channelId).not.toBe(b.channelId);
  });
  it('skips a protocol-incompatible route and returns a clear error if no route can translate', async () => {
    await catalog('Anthropic', 'anthropic', ['mixed'], ['shared']);
    const token = (await key({ allowed_tags: ['mixed'] })).key;
    const audioMessages = [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'YQ==', format: 'wav' } }] }];
    const unsupported = await chat(token, { model: 'shared', messages: audioMessages });
    expect(unsupported.status).toBe(400); expect(await unsupported.text()).toContain('unsupported_conversion'); expect(calls).toHaveLength(0);
    await catalog('Compatible', 'openai', ['mixed'], ['shared']);
    expect((await chat(token, { model: 'shared', messages: audioMessages })).status).toBe(200);
    expect(calls).toHaveLength(1); expect(calls[0].url).toContain('/custom-compatible/');
    expect(calls[0].body.messages).toEqual(audioMessages);
  });
  it('updates standard message paths when changing a provider protocol', async () => {
    const a = await catalog('A', 'openai', ['public'], ['shared']);
    await editProvider(a.provider, { protocol: 'anthropic' });
    expect(await db.prepare('SELECT gateway_path FROM channels WHERE id = ?').bind(a.channelId).first()).toMatchObject({ gateway_path: 'v1/messages' });
  });
  it('returns Anthropic-shaped authentication and validation errors', async () => {
    const noKey = await messages('invalid'); expect(noKey.status).toBe(401); expect(await noKey.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
    const invalid = await messages((await key()).key, { max_tokens: -1 }); expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } }); expect(calls).toHaveLength(0);
  });
  it('streams both converted protocols through the Worker and keeps Cloudflare log IDs', async () => {
    const token = (await key()).key;
    upstream = () => new MFResponse(`data: ${JSON.stringify({ ...completion, choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...completion, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    const response = await messages(token, { stream: true }); expect(response.status).toBe(200);
    const output = await response.text(); expect(output).toContain('event: message_start'); expect(output).toContain('event: message_stop'); expect(output).toContain('你好'); expect(output).not.toContain('event: error');
    expect(calls[0].body.stream_options).toEqual({ include_usage: true }); expect(response.headers.get('cf-aig-log-id')).toBeTruthy();
    await catalog('Anthropic', 'anthropic', ['claude'], ['sonnet']);
    upstream = () => new MFResponse([
      { type: 'message_start', message: { ...anthropicCompletion, content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 11 } }, { type: 'message_stop' },
    ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    const reverse = await chat((await key({ allowed_tags: ['claude'] })).key, { model: 'sonnet', stream: true, stream_options: { include_usage: true }, frequency_penalty: 0.6, vendor_option: true, temperature: 1.8 });
    expect(reverse.status).toBe(200); const reversed = await reverse.text(); expect(reversed).toContain('chat.completion.chunk'); expect(reversed).toContain('你好'); expect(reversed).toContain('[DONE]');
    expect(reversed).not.toContain('"error":');
    for (const field of ['frequency_penalty', 'vendor_option', 'temperature']) expect(calls.at(-1)!.body).not.toHaveProperty(field);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM request_logs').first()).toMatchObject({ n: 0 });
  });
});

describe('upstream model discovery', () => {
  it('requires an admin session and rejects cross-origin requests', async () => {
    const body = { base_url: 'https://supplier.example.com', secret: 'temporary-key' };
    expect((await request('/api/providers/models', { body })).status).toBe(401);
    expect((await request('/api/providers/models', { admin: true, body, headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect(modelCalls).toHaveLength(0);
  });
  it.each([
    ['https://supplier.example.com', 'https://supplier.example.com/v1/models'],
    ['https://supplier.example.com/v1/', 'https://supplier.example.com/v1/models'],
    ['https://supplier.example.com/api/', 'https://supplier.example.com/api/v1/models'],
    ['https://supplier.example.com/api/v1/', 'https://supplier.example.com/api/v1/models'],
  ])('fetches unique models using the entered URL %s without persisting anything', async (base_url, expected) => {
    const result = await admin('/providers/models', { base_url, secret: 'temporary-key' });
    expect(result).toEqual({ models: ['model-a', 'model-b'] });
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0].url).toBe(expected);
    expect(modelCalls[0].headers.authorization).toBe('Bearer temporary-key');
    expect(modelCalls[0].headers['cf-aig-authorization']).toBeUndefined();
    expect(modelCalls[0].headers.cookie).toBeUndefined();
    expect(providers.size).toBe(1);
    expect((await db.prepare('SELECT * FROM provider_profiles LIMIT 1').first())).toMatchObject({ models: '[]' });
    expect(await db.prepare("SELECT id FROM models WHERE id = 'model-a'").first()).toBeNull();
    expect(JSON.stringify(result)).not.toContain('temporary-key');
  });
  it('reuses the bound channel secret without returning it to the browser', async () => {
    const current = (await db.prepare('SELECT * FROM channels LIMIT 1').first<Channel>())!;
    const result = await admin('/providers/models', { base_url: current.base_url, channel_id: current.id, provider_id: current.provider_id });
    expect(result).toEqual({ models: ['model-a', 'model-b'] });
    expect(modelCalls[0].headers.authorization).toBe('Bearer provider-secret');
    expect(JSON.stringify(result)).not.toContain('provider-secret');
  });
  it.each(['base_url', 'provider_id', 'kind'])('does not reuse a saved credential after changing %s', async change => {
    const current = (await db.prepare('SELECT * FROM channels LIMIT 1').first<Channel>())!;
    const body = { base_url: current.base_url, channel_id: current.id, provider_id: current.provider_id };
    if (change === 'base_url') body.base_url = 'https://other.example.com';
    if (change === 'provider_id') body.provider_id = 'different-provider';
    if (change === 'kind') await db.prepare("UPDATE channels SET kind = 'cloudflare' WHERE id = ?").bind(current.id).run();
    expect((await request('/api/providers/models', { admin: true, body })).status).toBe(400);
    expect(modelCalls).toHaveLength(0);
  });
  it('uses an explicitly supplied key in preference to a saved key without rotating it', async () => {
    const current = (await db.prepare('SELECT * FROM channels LIMIT 1').first<Channel>())!;
    await admin('/providers/models', { base_url: current.base_url, channel_id: current.id, secret: 'temporary-override' });
    expect(modelCalls[0].headers.authorization).toBe('Bearer temporary-override');
    expect(await db.prepare('SELECT secret_encrypted FROM channels WHERE id = ?').bind(current.id).first()).toEqual({ secret_encrypted: current.secret_encrypted });
  });
  it('reads every Anthropic page with protocol-specific authentication', async () => {
    modelResponse = req => new URL(req.url).searchParams.has('after_id')
      ? MFResponse.json({ data: [{ id: 'claude-a' }, { id: 'claude-b' }], has_more: false })
      : MFResponse.json({ data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' });
    expect(await admin('/providers/models', { base_url: 'https://anthropic.example.com/v1', protocol: 'anthropic', secret: 'anthropic-key' })).toEqual({ models: ['claude-a', 'claude-b'] });
    expect(modelCalls).toHaveLength(2);
    expect(modelCalls[1].url).toContain('after_id=claude-a');
    expect(modelCalls[0].headers).toMatchObject({ 'x-api-key': 'anthropic-key', 'anthropic-version': '2023-06-01' });
    expect(modelCalls[0].headers.authorization).toBeUndefined();
  });
  it.each([401, 403, 404, 429, 500, 302])('returns a useful error for HTTP %s without exposing upstream bodies or following redirects', async status => {
    modelResponse = () => new MFResponse('temporary-key echoed by supplier', { status, headers: status === 302 ? { Location: 'https://redirect.example.com/v1/models' } : {} });
    const response = await request('/api/providers/models', { admin: true, body: { base_url: 'https://supplier.example.com', secret: 'temporary-key' } });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('temporary-key');
    expect(modelCalls).toHaveLength(1);
  });
  it.each([{}, { data: [] }, { data: [{ name: 'missing-id' }] }, { data: [{ id: 'invalid model id' }] }, { data: [{ id: 'model-a' }], has_more: true }])('rejects an incomplete or invalid catalog: %j', async payload => {
    modelResponse = () => MFResponse.json(payload);
    expect((await request('/api/providers/models', { admin: true, body: { base_url: 'https://supplier.example.com', secret: 'temporary-key' } })).status).toBe(502);
  });
  it('detects repeated pagination cursors instead of returning a partial catalog', async () => {
    modelResponse = () => MFResponse.json({ data: [{ id: 'model-a' }], has_more: true, last_id: 'model-a' });
    expect((await request('/api/providers/models', { admin: true, body: { base_url: 'https://supplier.example.com', protocol: 'anthropic', secret: 'temporary-key' } })).status).toBe(502);
    expect(modelCalls).toHaveLength(2);
  });
  it('supports more than 100 models through discovery and saving channel routes', async () => {
    const current = (await db.prepare('SELECT * FROM channels LIMIT 1').first<Channel>())!;
    const models = Array.from({ length: 600 }, (_, index) => `model-${String(index).padStart(3, '0')}-${'x'.repeat(110)}`);
    modelResponse = () => MFResponse.json({ data: models.map(id => ({ id })) });
    const discovered = await admin<{ models: string[] }>('/providers/models', { base_url: current.base_url, channel_id: current.id });
    expect(discovered.models).toEqual(models);
    await admin(`/channels/${current.id}`, { name: current.name, kind: 'openai', provider_id: current.provider_id, update_profile: true, models: discovered.models }, 'PUT');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM routes WHERE channel_id = ? AND managed_by_provider = 1').bind(current.id).first()).toEqual({ n: 600 });
  });
  it('rejects oversized model lists without truncating them', async () => {
    modelResponse = () => MFResponse.json({ data: Array.from({ length: 1001 }, (_, index) => ({ id: `model-${index}` })) });
    const response = await request('/api/providers/models', { admin: true, body: { base_url: 'https://supplier.example.com', secret: 'temporary-key' } });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('1000');
  });
  it('rejects unsafe URLs, absent keys and BYOK-only credentials before making requests', async () => {
    for (const base_url of ['http://supplier.example.com', 'https://127.0.0.1', 'https://localhost', 'https://user:pass@supplier.example.com']) {
      expect((await request('/api/providers/models', { admin: true, body: { base_url, secret: 'temporary-key' } })).status).toBe(400);
    }
    expect((await request('/api/providers/models', { admin: true, body: { base_url: 'https://supplier.example.com' } })).status).toBe(400);
    const current = (await db.prepare('SELECT * FROM channels LIMIT 1').first<Channel>())!;
    await db.prepare("UPDATE channels SET secret_encrypted = NULL, byok_alias = 'default' WHERE id = ?").bind(current.id).run();
    const response = await request('/api/providers/models', { admin: true, body: { base_url: current.base_url, channel_id: current.id } });
    expect(response.status).toBe(400); expect(await response.text()).toContain('BYOK');
    expect(modelCalls).toHaveLength(0);
  });
});

describe('editing shared provider profiles from channel forms', () => {
  it('updates the catalog and protocol of all linked channels while preserving manual aliases', async () => {
    const a = await catalog('Inline', 'openai', ['old'], ['old-model']);
    const b = await admin<{ id: string }>('/channels', { name: 'Second credential', kind: 'openai', provider_id: a.provider.id, secret: 'second-key' });
    await admin('/routes', { model_id: 'test-model', channel_id: a.channelId, upstream_model: 'old-model' });
    await admin(`/channels/${a.channelId}`, { name: 'Inline updated', kind: 'openai', provider_id: a.provider.id, update_profile: true, protocol: 'anthropic', tags: ['new'], models: ['new-model'], secret: 'anthropic-key', gateway_path: 'v1/messages' }, 'PUT');
    const list = await admin<(Channel & { protocol: string; models: string[]; tags: string[] })[]>('/channels');
    for (const id of [a.channelId, b.id]) expect(list.find(channel => channel.id === id)).toMatchObject({ protocol: 'anthropic', tags: ['new'], models: ['new-model'], gateway_path: 'v1/messages' });
    expect(await db.prepare('SELECT model_id FROM routes WHERE channel_id = ? ORDER BY model_id').bind(a.channelId).all()).toMatchObject({ results: [{ model_id: 'new-model' }, { model_id: 'test-model' }] });
  });
  it('does not overwrite a shared profile when saving only connection settings', async () => {
    const a = await catalog('Shared', 'openai', ['production'], ['current-model']);
    await admin(`/channels/${a.channelId}`, { name: 'Renamed', kind: 'openai', provider_id: a.provider.id, tags: ['stale'], models: ['stale-model'] }, 'PUT');
    expect(await db.prepare('SELECT tags, models FROM provider_profiles WHERE provider_id = ?').bind(a.provider.id).first()).toEqual({ tags: '["production"]', models: '["current-model"]' });
  });
  it('saves edited models when linking a new channel to an existing provider', async () => {
    const a = await catalog('Existing', 'openai', ['production'], ['old-model']);
    const b = await admin<{ id: string }>('/channels', { name: 'New link', kind: 'openai', provider_id: a.provider.id, secret: 'new-key', update_profile: true, tags: ['production'], models: ['new-model'] });
    expect(await db.prepare('SELECT model_id FROM routes WHERE channel_id = ?').bind(b.id).all()).toMatchObject({ results: [{ model_id: 'new-model' }] });
    expect(await db.prepare('SELECT model_id FROM routes WHERE channel_id = ?').bind(a.channelId).all()).toMatchObject({ results: [{ model_id: 'new-model' }] });
  });
});

describe('long channel timeout settings', () => {
  it('persists timeout values above 10 minutes when creating and updating channels', async () => {
    const created = await admin<{ id: string }>('/channels', { name: 'Long streaming', kind: 'cloudflare', timeout_ms: 1200000 });
    expect((await admin<Channel[]>('/channels')).find(c => c.id === created.id)?.timeout_ms).toBe(1200000);
    await admin(`/channels/${created.id}`, { name: 'Long streaming', kind: 'cloudflare', timeout_ms: 3600000 }, 'PUT');
    expect((await admin<Channel[]>('/channels')).find(c => c.id === created.id)?.timeout_ms).toBe(3600000);
    for (const timeout_ms of [999, 3600001]) expect((await request(`/api/channels/${created.id}`, { admin: true, method: 'PUT', body: { name: 'Long streaming', kind: 'cloudflare', timeout_ms } })).status).toBe(400);
    expect((await admin<Channel[]>('/channels')).find(c => c.id === created.id)?.timeout_ms).toBe(3600000);
  });
});

describe('channel automatic route creation', () => {
  it('saves an opted-out catalog without creating application models or routes', async () => {
    const created = await admin<{ id: string }>('/channels', { name: 'Manual catalog', kind: 'openai', provider_slug: 'manual-catalog', base_url: 'https://manual.example.com', secret: 'provider-key', models: ['catalog-only'], auto_create_routes: false });
    const saved = (await admin<Channel[]>('/channels')).find(channel => channel.id === created.id)!;
    expect(saved).toMatchObject({ auto_create_routes: 0, models: ['catalog-only'] });
    expect(await db.prepare('SELECT id FROM models WHERE id = ?').bind('catalog-only').first()).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM routes WHERE channel_id = ?').bind(created.id).first()).toEqual({ n: 0 });
    await admin('/models', { id: 'manual-alias' });
    await admin('/routes', { model_id: 'manual-alias', channel_id: created.id, upstream_model: 'catalog-only' });
    expect(await visibleModels((await key()).key)).toContain('manual-alias');
  });
  it.each([undefined, true])('creates routes when automatic creation is %s', async auto_create_routes => {
    const created = await admin<{ id: string }>('/channels', { name: 'Automatic', kind: 'openai', provider_slug: 'automatic', base_url: 'https://automatic.example.com', secret: 'provider-key', models: ['auto-model'], auto_create_routes });
    expect((await admin<Channel[]>('/channels')).find(channel => channel.id === created.id)).toMatchObject({ auto_create_routes: 1 });
    expect(await db.prepare('SELECT model_id, upstream_model, managed_by_provider FROM routes WHERE channel_id = ?').bind(created.id).all()).toMatchObject({ results: [{ model_id: 'auto-model', upstream_model: 'auto-model', managed_by_provider: 1 }] });
  });
  it('keeps the choice when editing or synchronizing a shared provider', async () => {
    const a = await catalog('SharedAuto', 'openai', ['public'], ['original']);
    const b = await admin<{ id: string }>('/channels', { name: 'Manual link', kind: 'openai', provider_id: a.provider.id, secret: 'second-key', auto_create_routes: false, update_profile: true, models: ['replacement'] });
    expect(await db.prepare('SELECT model_id FROM routes WHERE channel_id = ?').bind(a.channelId).all()).toMatchObject({ results: [{ model_id: 'replacement' }] });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM routes WHERE channel_id = ?').bind(b.id).first()).toEqual({ n: 0 });
    await editProvider(a.provider, { models: ['latest'] });
    // An older client omitting the flag must not silently turn it back on.
    await admin(`/channels/${b.id}`, { name: 'Renamed manual link', kind: 'openai', provider_id: a.provider.id }, 'PUT');
    expect((await admin<Channel[]>('/channels')).find(channel => channel.id === b.id)).toMatchObject({ auto_create_routes: 0, models: ['latest'] });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM routes WHERE channel_id = ?').bind(b.id).first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT model_id FROM routes WHERE channel_id = ?').bind(a.channelId).all()).toMatchObject({ results: [{ model_id: 'latest' }] });
  });
  it('preserves existing routes while off and reconciles the current catalog when re-enabled', async () => {
    const a = await catalog('ToggleAuto', 'openai', [], ['original']);
    const manual = await admin<{ id: string }>('/routes', { model_id: 'test-model', channel_id: a.channelId, upstream_model: 'original', priority: 3, weight: 7 });
    const before = (await db.prepare('SELECT * FROM routes WHERE channel_id = ? ORDER BY id').bind(a.channelId).all()).results;
    const update = { name: 'ToggleAuto', kind: 'openai', provider_id: a.provider.id };
    await admin(`/channels/${a.channelId}`, { ...update, auto_create_routes: false, update_profile: true, models: ['replacement'] }, 'PUT');
    await editProvider(a.provider, { models: ['latest'] });
    expect((await db.prepare('SELECT * FROM routes WHERE channel_id = ? ORDER BY id').bind(a.channelId).all()).results).toEqual(before);
    expect(await db.prepare('SELECT id FROM models WHERE id IN (?, ?)').bind('replacement', 'latest').all()).toMatchObject({ results: [] });
    await admin(`/channels/${a.channelId}`, { ...update, auto_create_routes: true }, 'PUT');
    await admin(`/channels/${a.channelId}`, update, 'PUT');
    expect(await db.prepare('SELECT model_id FROM routes WHERE channel_id = ? ORDER BY model_id').bind(a.channelId).all()).toMatchObject({ results: [{ model_id: 'latest' }, { model_id: 'test-model' }] });
    expect(await db.prepare('SELECT priority, weight, managed_by_provider FROM routes WHERE id = ?').bind(manual.id).first()).toEqual({ priority: 3, weight: 7, managed_by_provider: 0 });
  });
  it('rejects non-boolean choices before creating provider resources', async () => {
    const previousCalls = controlCalls.length;
    for (const auto_create_routes of ['false', 0, null]) {
      const response = await request('/api/channels', { admin: true, body: { name: 'Invalid', kind: 'openai', provider_slug: 'invalid', base_url: 'https://invalid.example.com', secret: 'provider-key', auto_create_routes } });
      expect(response.status).toBe(400);
    }
    expect(controlCalls).toHaveLength(previousCalls);
  });
});

describe('persisted gateway policy and retry limits', () => {
  it('persists settings and protects them with admin authentication and origin checks', async () => {
    expect(await admin('/config')).toMatchObject({ runtime: DEFAULT_GATEWAY_SETTINGS });
    const settings = { ...DEFAULT_GATEWAY_SETTINGS, load_balancing: 'random' as const, same_channel_retries: 5, cross_channel_retries: 10 };
    expect(await runtime(settings)).toEqual(settings);
    expect(await admin('/config')).toMatchObject({ runtime: settings });
    expect((await request('/api/config/runtime', { method: 'PUT', key: (await key()).key, body: DEFAULT_GATEWAY_SETTINGS })).status).toBe(401);
    expect((await request('/api/config/runtime', { method: 'PUT', admin: true, body: DEFAULT_GATEWAY_SETTINGS, headers: { Origin: 'https://external.example' } })).status).toBe(403);
    expect(await admin('/config')).toMatchObject({ runtime: settings });
  });
  it.each([
    { same_channel_retries: -1 }, { same_channel_retries: 6 }, { same_channel_retries: 1.5 },
    { cross_channel_retries: -1 }, { cross_channel_retries: 11 }, { cross_channel_retries: 1.5 },
    { load_balancing: 'invalid' }, { upstream_error_mode: 'invalid' },
    { upstream_error_rules: [{ code: '429', message: '' }] },
    { upstream_error_rules: [{ code: '429', message: 'one' }, { code: '429', message: 'two' }] },
    { upstream_error_rules: [{ code: '<script>', message: 'bad' }] },
  ])('rejects invalid runtime settings without overwriting saved settings: %j', async update => {
    const response = await request('/api/config/runtime', { admin: true, method: 'PUT', body: { ...DEFAULT_GATEWAY_SETTINGS, ...update } });
    expect(response.status).toBe(400);
    expect(await admin('/config')).toMatchObject({ runtime: DEFAULT_GATEWAY_SETTINGS });
  });
  it('treats zero retries as exactly one request, even with fallback channels', async () => {
    await runtime({ same_channel_retries: 0, cross_channel_retries: 0 });
    await route(await channel('Fallback', 'fallback.example.com'), 1);
    upstream = () => MFResponse.json({ error: { message: 'private failure' } }, { status: 503 });
    const response = await chat((await key()).key);
    expect(response.status).toBe(502); expect(response.headers.get('X-Gateway-Attempts')).toBe('1'); expect(calls).toHaveLength(1);
    expect(await response.text()).not.toContain('private failure');
  });
  it('retries the same route before switching, without charging quota again', async () => {
    await runtime({ same_channel_retries: 2, cross_channel_retries: 0 });
    upstream = () => calls.length < 3 ? MFResponse.json({ error: 'temporary' }, { status: 503 }) : MFResponse.json(completion);
    const created = await key({ rpm: 1 }), response = await chat(created.key);
    expect(response.status).toBe(200); expect(response.headers.get('X-Gateway-Attempts')).toBe('3');
    expect(new Set(calls.map(call => call.url)).size).toBe(1);
    expect(calls.map(call => JSON.parse(call.headers['cf-aig-metadata']).channel_attempt)).toEqual(['1', '2', '3']);
    expect(await db.prepare('SELECT minute_count FROM key_counters WHERE key_id = ?').bind(created.id).first()).toEqual({ minute_count: 1 });
    expect(await admin<UpstreamErrorTrace[]>(`/traces/${response.headers.get('X-Request-ID')}`)).toHaveLength(2);
  });
  it('counts distinct channels and never re-enters one through a duplicate route', async () => {
    const primary = (await admin<{ id: string }[]>('/channels'))[0];
    await route(primary.id, 1, 'same-channel-other-model');
    await route(await channel('Fallback', 'fallback.example.com'), 2);
    await route(await channel('Third', 'third.example.com'), 3);
    await runtime({ same_channel_retries: 1, cross_channel_retries: 1 });
    upstream = () => MFResponse.json({ error: 'temporary' }, { status: 503 });
    const response = await chat((await key()).key); expect(response.status).toBe(502);
    const meta = calls.map(call => JSON.parse(call.headers['cf-aig-metadata']));
    expect(meta.map(m => m.channel_name)).toEqual(['Primary', 'Primary', 'Fallback', 'Fallback']);
    expect(meta.map(m => m.channel_index)).toEqual(['1', '1', '2', '2']);
    expect(meta.map(m => m.attempt)).toEqual(['1', '2', '3', '4']);
  });
  it('honors five same-channel retries and stops after six attempts', async () => {
    await runtime({ same_channel_retries: 5, cross_channel_retries: 0 });
    upstream = () => MFResponse.json({ error: 'temporary' }, { status: 503 });
    const response = await chat((await key()).key); expect(response.status).toBe(502); expect(calls).toHaveLength(6);
  });
  it('supports ten channel switches without the previous five-route cap', async () => {
    await runtime({ cross_channel_retries: 10 });
    for (let i = 1; i <= 11; i++) await route(await channel(`Backup${i}`, `backup${i}.example.com`), i);
    upstream = () => MFResponse.json({ error: 'temporary' }, { status: 503 });
    const response = await chat((await key()).key); expect(response.status).toBe(502); expect(calls).toHaveLength(11);
    expect(new Set(calls.map(call => JSON.parse(call.headers['cf-aig-metadata']).channel_id)).size).toBe(11);
  });
  it('switches channels immediately on authentication failure, while parameter errors stop', async () => {
    await runtime({ same_channel_retries: 5, cross_channel_retries: 1 });
    await route(await channel('Fallback', 'fallback.example.com'), 1);
    upstream = req => req.url.includes('custom-primary/') ? MFResponse.json({ error: 'bad credentials' }, { status: 401 }) : MFResponse.json(completion);
    const token = (await key()).key; expect((await chat(token)).status).toBe(200); expect(calls).toHaveLength(2);
    calls = []; upstream = () => MFResponse.json({ error: 'bad parameter' }, { status: 400 });
    expect((await chat(token)).status).toBe(400); expect(calls).toHaveLength(1);
  });
  it('selects random channels uniformly regardless of duplicate routes, preserving priority', () => {
    const values = [
      { id: 'a', channel_id: 'one', priority: 0, weight: 999 },
      { id: 'a2', channel_id: 'one', priority: 0, weight: 999 },
      { id: 'b', channel_id: 'two', priority: 0, weight: 1 },
      { id: 'c', channel_id: 'three', priority: 1, weight: 9999 },
    ] as Candidate[];
    expect(orderCandidates(values, () => .6, 'random').map(r => r.channel_id)).toEqual(['two', 'one', 'three']);
    expect(orderCandidates(values, () => .6, 'weighted').map(r => r.channel_id)).toEqual(['one', 'two', 'three']);
  });
});

describe('upstream error disclosure and administrator traces', () => {
  const original = JSON.stringify({ error: { code: 'quota_exceeded', message: 'private provider detail' } });
  it.each(['hide', 'show', 'custom'] as const)('applies %s mode to HTTP errors while retaining the original body', async mode => {
    await runtime({ upstream_error_mode: mode, upstream_error_rules: [{ code: '400', message: 'HTTP fallback' }, { code: 'quota_exceeded', message: 'Custom quota message' }] });
    upstream = () => new MFResponse(original, { status: 400, headers: { 'content-type': 'application/json', 'x-private-header': 'provider-header-secret' } });
    const token = (await key()).key, response = await chat(token), text = await response.text();
    expect(response.status).toBe(400);
    if (mode === 'show') expect(text).toContain('private provider detail');
    else { expect(text).not.toContain('private provider detail'); expect(text).not.toContain('quota_exceeded'); }
    if (mode === 'custom') { expect(text).toContain('Custom quota message'); expect(text).not.toContain('HTTP fallback'); }
    const requestId = response.headers.get('X-Request-ID')!;
    const trace = await admin<UpstreamErrorTrace[]>(`/traces/${requestId}`);
    expect(trace).toHaveLength(1); expect(trace[0]).toMatchObject({ request_id: requestId, attempt: 1, error_body: original, error_code: 'quota_exceeded', status: 400, cf_log_id: 'cf-log-1' });
    expect(JSON.stringify(trace)).not.toContain('provider-header-secret'); expect(JSON.stringify(trace)).not.toContain('private prompt');
    expect((await request(`/api/traces/${requestId}`, { key: token })).status).toBe(401);
    remoteLogs = [logFixture({ id: 'cf-log-1' })];
    expect(await admin('/logs/cf-log-1')).toMatchObject({ upstream_error: { error_body: original } });
  });
  it('matches HTTP status rules and hides unmatched errors without replacing unrelated gateway errors', async () => {
    await runtime({ upstream_error_mode: 'custom', upstream_error_rules: [{ code: '429', message: 'Custom busy message' }] });
    const token = (await key()).key;
    upstream = () => new MFResponse(original, { status: 429 });
    expect(await (await chat(token)).text()).toContain('Custom busy message');
    upstream = () => new MFResponse(original, { status: 400 });
    expect(await (await chat(token)).text()).not.toContain('private provider detail');
    const unauthorized = await request('/v1/chat/completions', { body: { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] } });
    expect(unauthorized.status).toBe(401); expect(await unauthorized.text()).toContain('invalid_api_key');
  });
  it('uses the requested client protocol for HTTP errors', async () => {
    await runtime({ upstream_error_mode: 'show' });
    upstream = () => new MFResponse(original, { status: 400 });
    const response = await request('/v1/messages', { key: (await key()).key, body: { model: 'test-model', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] } });
    expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error', message: 'private provider detail' } });
  });
  it('matches numeric supplier error codes before HTTP status codes', async () => {
    await runtime({ upstream_error_mode: 'custom', upstream_error_rules: [{ code: '1001', message: 'Custom numeric error' }, { code: '400', message: 'HTTP fallback' }] });
    upstream = () => MFResponse.json({ errors: [{ code: 1001, message: 'internal detail' }] }, { status: 400 });
    const response = await chat((await key()).key);
    expect(await response.text()).toContain('Custom numeric error');
  });
  it.each(['hide', 'show', 'custom'] as const)('applies %s mode to same-protocol and converted SSE errors without retrying', async mode => {
    await runtime({ same_channel_retries: 2, cross_channel_retries: 2, upstream_error_mode: mode, upstream_error_rules: [{ code: 'quota_exceeded', message: 'Custom stream message' }] });
    await route(await channel('Fallback', 'fallback.example.com'), 1);
    upstream = () => new MFResponse(`data: ${original}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    const token = (await key()).key;
    for (const upstreamProtocol of ['openai', 'anthropic']) {
      await db.prepare('UPDATE provider_profiles SET protocol = ?').bind(upstreamProtocol).run();
      const raw = upstreamProtocol === 'anthropic' ? JSON.stringify({ type: 'error', ...JSON.parse(original) }) : original;
      upstream = () => new MFResponse(`data: ${raw}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      for (const protocol of ['openai', 'anthropic']) {
      const response = protocol === 'openai' ? await chat(token, { stream: true, max_tokens: 10 }) : await request('/v1/messages', { key: token, body: { model: 'test-model', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }], stream: true } });
      const text = await response.text();
      expect(text).toContain(mode === 'show' ? 'private provider detail' : mode === 'custom' ? 'Custom stream message' : '上游服务暂时无法完成请求');
      if (mode !== 'show') expect(text).not.toContain('private provider detail');
      const traces = await admin<UpstreamErrorTrace[]>(`/traces/${response.headers.get('X-Request-ID')}`);
      expect(traces).toHaveLength(1); expect(traces[0].error_body).toBe(raw);
      }
    }
    expect(calls).toHaveLength(4);
  });
  it('caps retained errors, marks truncation and excludes expired traces', async () => {
    upstream = () => new MFResponse('x'.repeat(20000), { status: 400 });
    const response = await chat((await key()).key), id = response.headers.get('X-Request-ID')!;
    const traces = await admin<UpstreamErrorTrace[]>(`/traces/${id}`);
    expect(traces[0].error_body.length).toBe(16384); expect(traces[0].truncated).toBe(1);
    await db.prepare("UPDATE upstream_error_traces SET created_at = '2000-01-01T00:00:00.000Z'").run();
    expect(await admin(`/traces/${id}`)).toEqual([]);
  });
});


const responsesCompletion = { id: 'resp_test', object: 'response', created_at: 1, status: 'completed', model: 'upstream-test', error: null, incomplete_details: null,
  output: [{ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '你好，世界', annotations: [] }] }],
  usage: { input_tokens: 7, output_tokens: 11, total_tokens: 18, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
const responses = (token: string, extra = {}) => request('/v1/responses', { key: token, body: { model: 'test-model', input: '你好', max_output_tokens: 100, store: false, ...extra } });
const responsePairs: [Protocol, Protocol][] = [['responses', 'openai'], ['responses', 'anthropic'], ['responses', 'responses'], ['openai', 'responses'], ['anthropic', 'responses']];
function protocolSSE(protocol: Protocol) {
  const event = (value: Record<string, unknown>) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
  if (protocol === 'responses') return [
    { type: 'response.created', response: { ...responsesCompletion, status: 'in_progress', output: [], usage: null } },
    { type: 'response.in_progress', response: { ...responsesCompletion, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_item.added', output_index: 0, item: { ...responsesCompletion.output[0], status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, item_id: 'msg_test', content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_test', content_index: 0, delta: '你好，世界' },
    { type: 'response.output_text.done', output_index: 0, item_id: 'msg_test', content_index: 0, text: '你好，世界' },
    { type: 'response.content_part.done', output_index: 0, item_id: 'msg_test', content_index: 0, part: responsesCompletion.output[0].content[0] },
    { type: 'response.output_item.done', output_index: 0, item: responsesCompletion.output[0] },
    { type: 'response.completed', response: responsesCompletion },
  ].map((value, sequence_number) => event({ ...value, sequence_number })).join('');
  if (protocol === 'anthropic') return [
    { type: 'message_start', message: { ...anthropicCompletion, content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好，世界' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 11 } }, { type: 'message_stop' },
  ].map(event).join('');
  return `data: ${JSON.stringify({ ...completion, choices: [{ index: 0, delta: { role: 'assistant', content: '你好，世界' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...completion, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
}

describe('Responses API through the gateway', () => {
  it.each(responsePairs)('converts JSON from %s upstream to %s client with tag and credential isolation', async (upstreamProtocol, clientProtocol) => {
    await catalog('ResponsesTest', upstreamProtocol, ['responses-test'], ['test-model']);
    const token = (await key({ allowed_tags: ['responses-test'] })).key;
    upstream = () => MFResponse.json(upstreamProtocol === 'responses' ? responsesCompletion : upstreamProtocol === 'anthropic' ? anthropicCompletion : completion);
    const result = clientProtocol === 'responses' ? await responses(token) : clientProtocol === 'anthropic' ? await messages(token) : await chat(token);
    expect(result.status).toBe(200);
    const json = await result.json();
    if (clientProtocol === 'responses') expect(json).toMatchObject({ object: 'response', status: 'completed', output: [{ role: 'assistant', content: [{ type: 'output_text', text: '你好，世界' }] }], usage: { input_tokens: 7, output_tokens: 11 } });
    else if (clientProtocol === 'anthropic') expect(json).toMatchObject({ type: 'message', content: [{ type: 'text', text: '你好，世界' }] });
    else expect(json).toMatchObject({ object: 'chat.completion', choices: [{ message: { content: '你好，世界' } }] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/custom-responsestest/v1/${upstreamProtocol === 'responses' ? 'responses' : upstreamProtocol === 'anthropic' ? 'messages' : 'chat/completions'}`);
    expect(calls[0].headers['cf-aig-authorization']).toBe('Bearer cf-inference-token');
    expect(calls[0].headers[upstreamProtocol === 'anthropic' ? 'x-api-key' : 'authorization']).toBe(upstreamProtocol === 'anthropic' ? 'responsestest-provider-key' : 'Bearer responsestest-provider-key');
    expect(JSON.parse(calls[0].headers['cf-aig-metadata'])).toMatchObject({ client_protocol: clientProtocol, upstream_protocol: upstreamProtocol });
    expect(calls[0].body).toHaveProperty(upstreamProtocol === 'responses' ? 'input' : 'messages');
    expect(calls[0].body).not.toHaveProperty(upstreamProtocol === 'responses' ? 'messages' : 'input');
    expect(JSON.stringify(calls)).not.toContain(token);
  });
  it.each(responsePairs)('streams %s upstream to %s client and keeps log IDs', async (upstreamProtocol, clientProtocol) => {
    await catalog('ResponsesStream', upstreamProtocol, ['responses-stream'], ['test-model']);
    const token = (await key({ allowed_tags: ['responses-stream'] })).key;
    upstream = () => new MFResponse(protocolSSE(upstreamProtocol), { headers: { 'Content-Type': 'text/event-stream' } });
    const result = clientProtocol === 'responses' ? await responses(token, { stream: true }) : clientProtocol === 'anthropic' ? await messages(token, { stream: true }) : await chat(token, { stream: true, stream_options: { include_usage: true } });
    expect(result.status).toBe(200);
    const output = await result.text();
    expect(output).toContain('你好，世界'); expect(output).not.toContain('event: error'); expect(output).not.toContain('"error":{');
    expect(output).toContain(clientProtocol === 'responses' ? 'event: response.completed' : clientProtocol === 'anthropic' ? 'event: message_stop' : 'data: [DONE]');
    expect(result.headers.get('cf-aig-log-id')).toBe('cf-log-1'); expect(calls).toHaveLength(1);
    if (upstreamProtocol === 'openai') expect(calls[0].body.stream_options).toEqual({ include_usage: true });
    if (upstreamProtocol === 'responses') expect(calls[0].body).not.toHaveProperty('stream_options');
  });
  it('preserves native Responses fields but rejects them before calling an incompatible upstream', async () => {
    const token = (await key()).key;
    const unsupported = await responses(token, { previous_response_id: 'resp_private' });
    expect(unsupported.status).toBe(400); expect(await unsupported.text()).toContain('unsupported_conversion'); expect(calls).toHaveLength(0);
    await catalog('NativeResponses', 'responses', ['native-responses'], ['test-model']);
    upstream = () => MFResponse.json(responsesCompletion);
    const native = await responses((await key({ allowed_tags: ['native-responses'] })).key, { previous_response_id: 'resp_private', store: false, tools: [{ type: 'web_search' }], reasoning: { effort: 'medium' } });
    expect(native.status).toBe(200); expect(await native.json()).toEqual(responsesCompletion);
    expect(calls[0].body).toMatchObject({ previous_response_id: 'resp_private', store: false, tools: [{ type: 'web_search' }], reasoning: { effort: 'medium' } });
  });
  it('rejects ambiguous provider-owned state without attempting another channel', async () => {
    await catalog('StateOne', 'responses', ['state'], ['test-model']);
    await catalog('StateTwo', 'responses', ['state'], ['test-model']);
    const token = (await key({ allowed_tags: ['state'] })).key;
    const result = await responses(token, { previous_response_id: 'resp_private' });
    expect(result.status).toBe(400); expect(await result.text()).toContain('unsupported_response_state'); expect(calls).toHaveLength(0);
  });
  it('enforces authentication, model access, validation and quota on Responses', async () => {
    expect((await responses('invalid')).status).toBe(401);
    const restricted = await key({ allowed_models: ['test-model'] });
    expect((await responses(restricted.key, { model: 'denied' })).status).toBe(403);
    expect((await responses(restricted.key, { input: 42 })).status).toBe(400);
    expect((await responses(restricted.key, { max_output_tokens: 0 })).status).toBe(400);
    expect(calls).toHaveLength(0);
    const limited = await key({ daily_limit: 1 });
    const first = await responses(limited.key); expect(first.status).toBe(200); await first.text();
    expect((await responses(limited.key)).status).toBe(429); expect(calls).toHaveLength(1);
  });
  it('re-converts Responses requests on fallback without escaping the API key tags', async () => {
    await catalog('FirstResponses', 'responses', ['retry-responses'], ['shared']);
    const next = await catalog('NextChat', 'openai', ['retry-responses'], ['shared']);
    await catalog('Excluded', 'responses', ['other'], ['shared']);
    await db.prepare('UPDATE routes SET priority = 1 WHERE channel_id = ?').bind(next.channelId).run();
    upstream = req => req.url.includes('/custom-firstresponses/') ? MFResponse.json({ error: { message: 'busy' } }, { status: 503 }) : MFResponse.json(completion);
    const result = await responses((await key({ allowed_tags: ['retry-responses'] })).key, { model: 'shared', instructions: 'rule' });
    expect(result.status).toBe(200); await result.text(); expect(calls).toHaveLength(2);
    expect(calls[0].body).toMatchObject({ input: '你好', instructions: 'rule' });
    expect(calls[1].body).not.toHaveProperty('input'); expect(JSON.stringify(calls[1].body.messages)).toContain('rule');
    expect(calls[1].url).toContain('/custom-nextchat/'); expect(result.headers.get('X-Gateway-Attempts')).toBe('2');
  });
  it('hides nested Responses stream errors and records their original code and body', async () => {
    await catalog('FailedResponses', 'responses', ['failed-responses'], ['test-model']);
    const token = (await key({ allowed_tags: ['failed-responses'] })).key;
    const raw = { type: 'response.failed', sequence_number: 0, response: { ...responsesCompletion, status: 'failed', error: { code: 'provider_private', message: 'sensitive upstream detail' } } };
    upstream = () => new MFResponse(`event: response.failed\ndata: ${JSON.stringify(raw)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    const result = await responses(token, { stream: true });
    const output = await result.text(); expect(output).toContain('event: error'); expect(output).not.toContain('sensitive upstream detail');
    const traces = (await db.prepare('SELECT error_code, error_body FROM upstream_error_traces WHERE request_id = ?').bind(result.headers.get('X-Request-ID')).all()).results;
    expect(traces).toHaveLength(1); expect(traces[0]).toMatchObject({ error_code: 'provider_private' }); expect(traces[0].error_body).toContain('sensitive upstream detail');
    await runtime({ upstream_error_mode: 'custom', upstream_error_rules: [{ code: 'provider_private', message: '自定义上游繁忙' }] });
    const custom = await responses(token, { stream: true }); expect(await custom.text()).toContain('自定义上游繁忙');
  });
  it('records failed Responses JSON even when the provider returns HTTP 200', async () => {
    await catalog('FailedJson', 'responses', ['failed-json'], ['test-model']);
    upstream = () => MFResponse.json({ ...responsesCompletion, status: 'failed', error: { code: 'provider_failure', message: 'private failure detail' } });
    const result = await responses((await key({ allowed_tags: ['failed-json'] })).key);
    expect(result.status).toBe(502); expect(await result.text()).not.toContain('private failure detail');
    expect(await db.prepare('SELECT error_code, error_body FROM upstream_error_traces WHERE request_id = ?').bind(result.headers.get('X-Request-ID')).first()).toMatchObject({ error_code: 'provider_failure', error_body: expect.stringContaining('private failure detail') });
  });
  it('updates Responses paths, preserves custom paths, and discovers models with Bearer credentials', async () => {
    const a = await catalog('ProtocolSwitch', 'openai', ['switch'], ['shared']);
    const b = await admin<{ id: string }>('/channels', { name: 'CustomPath', kind: 'openai', provider_id: a.provider.id, secret: 'secret', gateway_path: 'special/invoke' });
    await editProvider(a.provider, { protocol: 'responses' });
    expect(await db.prepare('SELECT gateway_path FROM channels WHERE id = ?').bind(a.channelId).first()).toMatchObject({ gateway_path: 'v1/responses' });
    expect(await db.prepare('SELECT gateway_path FROM channels WHERE id = ?').bind(b.id).first()).toMatchObject({ gateway_path: 'special/invoke' });
    const c = await admin<{ id: string }>('/channels', { name: 'VersionedResponses', kind: 'openai', provider_slug: 'versioned-responses', base_url: 'https://versioned.example.com/v1', protocol: 'responses', secret: 'secret' });
    expect(await db.prepare('SELECT gateway_path FROM channels WHERE id = ?').bind(c.id).first()).toMatchObject({ gateway_path: 'responses' });
    expect(await admin('/providers/models', { base_url: 'https://versioned.example.com/v1', protocol: 'responses', secret: 'discovery-key' })).toEqual({ models: ['model-a', 'model-b'] });
    expect(modelCalls[0].url).toBe('https://versioned.example.com/v1/models'); expect(modelCalls[0].headers.authorization).toBe('Bearer discovery-key'); expect(modelCalls[0].headers['anthropic-version']).toBeUndefined();
  });
});


describe('custom application models during route creation', () => {
  it('creates a new public ID and its manual route in the selected tag, forwarding the original upstream ID', async () => {
    const a = await catalog('CustomIdA', 'openai', ['AA'], []);
    await catalog('CustomIdB', 'openai', ['BB'], []);
    const created = await admin<{ id: string; model_id: string; model_created: boolean }>('/routes?tag=AA', {
      create_model: true, model_id: ' glm-5.3 ', channel_id: a.channelId, upstream_model: 'cline-pass/glm-5.3', weight: 3,
    });
    expect(created).toMatchObject({ model_id: 'glm-5.3', model_created: true });
    expect(await db.prepare('SELECT * FROM routes WHERE id = ?').bind(created.id).first()).toMatchObject({ model_id: 'glm-5.3', upstream_model: 'cline-pass/glm-5.3', managed_by_provider: 0, weight: 3 });
    expect(await admin('/models?tag=AA')).toMatchObject([{ id: 'glm-5.3', routes: [{ id: created.id }] }]);
    expect(await admin('/models?tag=BB')).toEqual([]);
    const aa = (await key({ allowed_tags: ['AA'] })).key, bb = (await key({ allowed_tags: ['BB'] })).key;
    expect(await visibleModels(aa)).toEqual(['glm-5.3']); expect(await visibleModels(bb)).toEqual([]);
    const result = await chat(aa, { model: 'glm-5.3' }); expect(result.status).toBe(200); await result.text();
    expect(calls).toHaveLength(1); expect(calls[0].body.model).toBe('cline-pass/glm-5.3');
    expect(calls[0].url).toContain('/custom-customida/');
    expect((await chat(bb, { model: 'glm-5.3' })).status).toBe(403);
    const restricted = (await key({ allowed_tags: ['AA'], allowed_models: ['test-model'] })).key;
    expect((await chat(restricted, { model: 'glm-5.3' })).status).toBe(403); expect(calls).toHaveLength(1);
    await editProvider(a.provider, { models: ['another-model'] });
    expect(await db.prepare('SELECT id FROM routes WHERE id = ?').bind(created.id).first()).toEqual({ id: created.id });
  });
  it('reuses existing global models without changing their state, description or other routes', async () => {
    const a = await catalog('ReuseModel', 'openai', ['AA'], []);
    await admin('/models/test-model', { description: 'Do not overwrite', enabled: false }, 'PUT');
    const original = (await db.prepare("SELECT * FROM routes WHERE model_id = 'test-model'").all()).results;
    const created = await admin<{ model_created: boolean }>('/routes?tag=AA', { create_model: true, model_id: 'test-model', channel_id: a.channelId, upstream_model: 'custom-upstream' });
    expect(created.model_created).toBe(false);
    expect(await db.prepare("SELECT description, enabled FROM models WHERE id = 'test-model'").first()).toEqual({ description: 'Do not overwrite', enabled: 0 });
    for (const old of original) expect(await db.prepare('SELECT * FROM routes WHERE id = ?').bind(old.id).first()).toEqual(old);
  });
  it('creates the first model in an empty registry under the untagged scope', async () => {
    await db.prepare('DELETE FROM models').run();
    const channel = await db.prepare("SELECT id FROM channels WHERE name = 'Primary'").first<{ id: string }>();
    await admin('/routes?untagged=1', { create_model: true, model_id: 'first-model', channel_id: channel!.id, upstream_model: 'provider-first' });
    expect(await admin('/models?untagged=1')).toMatchObject([{ id: 'first-model', routes: [{ upstream_model: 'provider-first' }] }]);
  });
  it('rejects invalid IDs, missing opt-in, invalid opt-in and out-of-scope channels without creating models', async () => {
    const a = await catalog('ValidateCustom', 'openai', ['AA'], []);
    const input = { model_id: 'must-not-exist', channel_id: a.channelId, upstream_model: 'upstream' };
    for (const create_model of [undefined, false, 'true', 1, null]) expect((await request('/api/routes?tag=AA', { admin: true, body: { ...input, create_model } })).status).toBe(400);
    for (const model_id of ['', 'bad name', 'x'.repeat(161)]) expect((await request('/api/routes?tag=AA', { admin: true, body: { ...input, create_model: true, model_id } })).status).toBe(400);
    for (const suffix of ['?tag=BB', '?tag=deleted', '?untagged=1']) expect((await request(`/api/routes${suffix}`, { admin: true, body: { ...input, create_model: true } })).status).toBe(400);
    expect((await request('/api/routes', { admin: true, body: { ...input, create_model: true, channel_id: 'missing-channel' } })).status).toBe(400);
    expect((await request('/api/routes?tag=AA', { body: { ...input, create_model: true } })).status).toBe(401);
    expect(await db.prepare("SELECT id FROM models WHERE id = 'must-not-exist'").first()).toBeNull();
    expect(await db.prepare('SELECT id FROM routes WHERE channel_id = ?').bind(a.channelId).first()).toBeNull();
  });
  it('rolls back the new model if inserting its route fails', async () => {
    const a = await catalog('AtomicModel', 'openai', ['AA'], []);
    await db.prepare("CREATE TRIGGER fail_custom_route BEFORE INSERT ON routes WHEN NEW.model_id = 'rollback-model' BEGIN SELECT RAISE(ABORT, 'injected route failure'); END").run();
    try {
      const result = await request('/api/routes?tag=AA', { admin: true, body: { create_model: true, model_id: 'rollback-model', channel_id: a.channelId, upstream_model: 'upstream' } });
      expect(result.status).toBe(500); await result.text();
      expect(await db.prepare("SELECT id FROM models WHERE id = 'rollback-model'").first()).toBeNull();
      expect(await db.prepare("SELECT id FROM routes WHERE model_id = 'rollback-model'").first()).toBeNull();
    } finally { await db.prepare('DROP TRIGGER fail_custom_route').run(); }
  });
  it('allows concurrent model reuse while rejecting duplicate routes', async () => {
    const a = await catalog('ConcurrentModel', 'openai', ['AA'], []);
    const input = { create_model: true, model_id: 'shared-new-model', channel_id: a.channelId, upstream_model: 'upstream' };
    const results = await Promise.all([request('/api/routes?tag=AA', { admin: true, body: input }), request('/api/routes?tag=AA', { admin: true, body: input })]);
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    await Promise.all(results.map(result => result.text()));
    expect(await db.prepare("SELECT COUNT(*) AS n FROM models WHERE id = 'shared-new-model'").first()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM routes WHERE model_id = 'shared-new-model'").first()).toEqual({ n: 1 });
  });
});
