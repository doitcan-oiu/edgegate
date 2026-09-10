import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { Miniflare, convertV4MiniflareOptions, Response as MFResponse, type Request as MFRequest } from 'miniflare';
import { decryptSecret, encryptSecret } from '../worker/lib/crypto';
import { orderCandidates } from '../worker/upstream';
import { safeBaseUrl } from '../worker/lib/validation';
import type { Candidate, Channel, Env } from '../worker/types';
import worker from '../worker/index';

const ADMIN = 'test-admin-token-with-at-least-32-characters';
const ENCRYPTION = btoa('12345678901234567890123456789012');
const completion = { id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'upstream-test', choices: [{ index: 0, message: { role: 'assistant', content: '你好，世界' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 } };
const account = 'a'.repeat(32), root = `/client/v4/accounts/${account}/ai-gateway`;
type Recorded = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
type Provider = { id: string; name: string; slug: string; base_url: string; enable: boolean; headers?: string };
type RemoteLog = { id: string; model: string; provider: string; success: boolean; status_code?: number; tokens_in: number | null; tokens_out: number | null; duration: number; cost?: number; cached: boolean; created_at: string; metadata?: string; request_head?: string };
let mf: Miniflare, db: Awaited<ReturnType<Miniflare['getD1Database']>>, cookie = '';
let upstream: (request: MFRequest) => Promise<MFResponse> | MFResponse;
let calls: Recorded[], controlCalls: Recorded[], providers: Map<string, Provider>, remoteLogs: RemoteLog[];
let controlFailure = 0, graphqlFailure = false;
const ok = (result: unknown, info?: unknown) => MFResponse.json({ success: true, result, ...(info ? { result_info: info } : {}) });
const fail = (status: number) => MFResponse.json({ success: false, errors: [{ message: 'sensitive Cloudflare response' }] }, { status });

async function outbound(req: MFRequest): Promise<MFResponse> {
  const url = new URL(req.url), body = req.method === 'GET' || req.method === 'DELETE' ? {} : await req.clone().json() as Record<string, unknown>;
  const record = { url: req.url, headers: Object.fromEntries(req.headers), body };
  if (url.hostname === 'api.cloudflare.com' && !url.pathname.includes('/ai/v1/')) {
    controlCalls.push(record);
    if (controlFailure) return fail(controlFailure);
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
      let rows = remoteLogs;
      if (url.searchParams.has('success')) rows = rows.filter(l => l.success === (url.searchParams.get('success') === 'true'));
      if (url.searchParams.get('model')) rows = rows.filter(l => l.model === url.searchParams.get('model'));
      const page = Number(url.searchParams.get('page') || 1), per = Number(url.searchParams.get('per_page') || 25);
      return ok(rows.slice((page - 1) * per, page * per), { total_count: rows.length, total_pages: Math.ceil(rows.length / per) });
    }
    if (url.pathname.startsWith(`${root}/gateways/test-gateway/logs/`)) return remoteLogs.find(l => l.id === url.pathname.split('/').at(-1)) ? ok(remoteLogs.find(l => l.id === url.pathname.split('/').at(-1))) : fail(404);
    return fail(404);
  }
  // This mock forbids every supplier-direct request. Only Cloudflare is a valid inference destination.
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
function logFixture(overrides: Partial<RemoteLog> = {}): RemoteLog { return { id: 'cf-remote-log', model: 'cloud-model', provider: 'custom-primary', status_code: 200, success: true, tokens_in: 7, tokens_out: 11, duration: 1234, cost: 0.0001, cached: false, created_at: new Date().toISOString(), metadata: JSON.stringify({ request_id: 'edge-request', model_alias: 'test-model', key_name: 'Test app', attempt: '1', channel_name: 'Primary' }), ...overrides }; }

beforeAll(async () => {
  const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'edgegate-test', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'],
    bindings: { ADMIN_TOKEN: ADMIN, ENCRYPTION_KEY: ENCRYPTION, CLOUDFLARE_ACCOUNT_ID: account, AI_GATEWAY_ID: 'test-gateway', CF_AI_TOKEN: 'cf-ai-token', CF_AIG_TOKEN: 'cf-inference-token', CF_API_TOKEN: 'cf-control-token' }, d1Databases: ['DB'], kvNamespaces: ['KV'], outboundService: outbound }));
  db = await mf.getD1Database('DB');
  for (const file of ['0001_initial.sql', '0002_ai_gateway_control_plane.sql', '0003_protocols_and_tags.sql']) {
    const migration = await readFile(`migrations/${file}`, 'utf8');
    await db.batch(migration.split(';').filter(s => s.replace(/--[^\n]*/g, '').trim()).map(sql => db.prepare(sql)));
  }
});
beforeEach(async () => {
  calls = []; controlCalls = []; providers = new Map(); remoteLogs = []; controlFailure = 0; graphqlFailure = false;
  upstream = () => MFResponse.json(completion);
  await db.batch(['provider_profiles', 'request_logs', 'key_counters', 'api_keys', 'routes', 'models', 'channels'].map(table => db.prepare(`DELETE FROM ${table}`)));
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
    const response = await chat((await key()).key, { stream: true }); expect(await response.text()).toContain('upstream interrupted'); expect(calls).toHaveLength(1);
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

describe('Cloudflare logs and analytics as the source of truth', () => {
  it('reads paginated logs from Cloudflare and preserves metadata correlation', async () => {
    remoteLogs = Array.from({ length: 26 }, (_, i) => logFixture({ id: `remote-${i}` }));
    const result = await admin<{ data: Record<string, unknown>[]; total: number; has_more: boolean }>('/logs?page=2');
    expect(result.total).toBe(26); expect(result.has_more).toBe(false); expect(result.data).toHaveLength(1); expect(result.data[0]).toMatchObject({ id: 'remote-25', request_id: 'edge-request', model: 'test-model', upstream_model: 'cloud-model', status: 200, key_name: 'Test app', source: 'cloudflare' });
  });
  it('uses upstream model and success filters on the Cloudflare API', async () => {
    remoteLogs = [logFixture(), logFixture({ id: 'failed', model: 'other-model', success: false, status_code: 500 })];
    expect(await admin('/logs?status=error&model=other-model')).toMatchObject({ total: 1, data: [{ id: 'failed' }] });
    expect(controlCalls.at(-1)?.url).toContain('success=false'); expect(controlCalls.at(-1)?.url).toContain('model=other-model');
  });
  it('retrieves log detail without returning secret-bearing request headers', async () => {
    remoteLogs = [logFixture({ request_head: 'Authorization: secret' })];
    const detail = await admin(`/logs/${remoteLogs[0].id}`); expect(detail).toMatchObject({ id: remoteLogs[0].id, source: 'cloudflare' }); expect(detail).not.toHaveProperty('request_head'); expect(JSON.stringify(detail)).not.toContain('Authorization');
  });
  it('does not fabricate missing status, tokens, or costs', async () => {
    remoteLogs = [logFixture({ status_code: undefined, tokens_in: null, tokens_out: null, cost: undefined, metadata: '{invalid' })];
    const result = await admin<{ data: Record<string, unknown>[] }>('/logs'); expect(result.data[0]).toMatchObject({ status: null, input_tokens: null, output_tokens: null, cost_usd: null, key_name: '外部调用', model: 'cloud-model' });
  });
  it('uses GraphQL aggregates independently of retained log pages or local storage', async () => {
    remoteLogs = [logFixture()];
    const result = await admin('/stats?range=24h'); expect(result).toMatchObject({ source: 'cloudflare', scope: 'gateway', summary: { requests: 12345, successes: 12300, input_tokens: 500000, output_tokens: 100000, cost_usd: 4.25, cache_hits: 1000 } });
    const query = String(controlCalls.at(-1)?.body.query); expect(query).toContain('aiGatewayRequestsAdaptiveGroups'); expect(query).toContain('gateway: "test-gateway"'); expect(query).toContain(`accountTag: "${account}"`);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM request_logs').first()).toMatchObject({ n: 0 });
  });
  it('reports Cloudflare failures rather than showing fabricated zero totals', async () => {
    graphqlFailure = true; const stats = await request('/api/stats', { admin: true }); expect(stats.status).toBe(502); expect(await stats.text()).toContain('cloudflare_analytics_error');
    controlFailure = 403; expect((await request('/api/logs', { admin: true })).status).toBe(502);
  });
  it('does not modify legacy D1 logs when querying Cloudflare or calling models', async () => {
    await db.prepare("INSERT INTO request_logs (id,key_id,model,status,latency_ms) VALUES ('legacy','old','old-model',200,3)").run();
    expect(await admin('/logs')).toMatchObject({ total: 0 }); await chat((await key()).key);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM request_logs').first()).toMatchObject({ n: 1 });
  });
});

describe('local crypto and routing rules', () => {
  it('binds encrypted credentials to a channel', async () => { const value = await encryptSecret('secret', ENCRYPTION, 'a'); expect(await decryptSecret(value, ENCRYPTION, 'a')).toBe('secret'); await expect(decryptSecret(value, ENCRYPTION, 'b')).rejects.toThrow(); });
  it('orders priorities and weights without duplicate attempts', () => { const values = [{ id: 'a', priority: 0, weight: 1 }, { id: 'b', priority: 0, weight: 9 }, { id: 'c', priority: 1, weight: 1000 }] as Candidate[]; expect(orderCandidates(values, () => 0.5).map(c => c.id)).toEqual(['b', 'a', 'c']); });
  it.each(['http://api.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://a.local', 'https://user:pass@api.example.com', 'https://api.example.com:8443', 'https://api.example.com?secret=x'])('rejects unsafe provider URL %s', url => { expect(() => safeBaseUrl(url)).toThrow(); });
});

async function catalog(name: string, protocol: 'openai' | 'anthropic', tags: string[], models: string[]) {
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
  it('accepts x-api-key on /v1/messages and converts requests to OpenAI', async () => {
    const response = await messages((await key()).key, { system: '规则', stop_sequences: ['END'] });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'text', text: '你好，世界' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 11 } });
    expect(calls[0].url).toContain('/custom-primary/v1/chat/completions');
    expect(calls[0].body).toMatchObject({ messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '你好' }], max_tokens: 100, stop: ['END'] });
    expect(calls[0].headers['x-api-key']).toBeUndefined(); expect(calls[0].headers['anthropic-version']).toBeUndefined();
    expect(calls[0].headers.authorization).toBe('Bearer provider-secret');
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
    const response = await chat((await key({ allowed_tags: ['mixed'] })).key, { model: 'shared', messages: [{ role: 'system', content: 'rule' }, { role: 'user', content: 'question' }] });
    expect(response.status).toBe(200); expect(calls).toHaveLength(2);
    expect(calls[0].body.system).toEqual([{ type: 'text', text: 'rule' }]);
    expect(calls[1].body.messages).toEqual([{ role: 'system', content: 'rule' }, { role: 'user', content: 'question' }]);
    expect(calls[1].body).not.toHaveProperty('system'); expect(response.headers.get('X-Gateway-Attempts')).toBe('2');
    expect(calls[0].headers['x-api-key']).toBe('anthropic-provider-key'); expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[1].headers.authorization).toBe('Bearer compatible-provider-key'); expect(calls[1].headers['x-api-key']).toBeUndefined();
    expect(a.channelId).not.toBe(b.channelId);
  });
  it('skips a protocol-incompatible route and returns a clear error if no route can translate', async () => {
    await catalog('Anthropic', 'anthropic', ['mixed'], ['shared']);
    const token = (await key({ allowed_tags: ['mixed'] })).key;
    const unsupported = await chat(token, { model: 'shared', response_format: { type: 'json_object' } });
    expect(unsupported.status).toBe(400); expect(await unsupported.text()).toContain('unsupported_conversion'); expect(calls).toHaveLength(0);
    await catalog('Compatible', 'openai', ['mixed'], ['shared']);
    expect((await chat(token, { model: 'shared', response_format: { type: 'json_object' } })).status).toBe(200);
    expect(calls).toHaveLength(1); expect(calls[0].url).toContain('/custom-compatible/');
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
    const reverse = await chat((await key({ allowed_tags: ['claude'] })).key, { model: 'sonnet', stream: true, stream_options: { include_usage: true } });
    expect(reverse.status).toBe(200); const reversed = await reverse.text(); expect(reversed).toContain('chat.completion.chunk'); expect(reversed).toContain('你好'); expect(reversed).toContain('[DONE]');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM request_logs').first()).toMatchObject({ n: 0 });
  });
});
