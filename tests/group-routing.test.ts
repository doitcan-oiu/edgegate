import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { iterateCandidates, orderCandidates } from '../worker/upstream';
import type { Candidate, Env, RouteGroup } from '../worker/types';
import type { GatewaySettings } from '../shared/gateway-settings';

const noDatabase = {} as Env;
function group(id: string, overrides: Partial<RouteGroup> = {}): RouteGroup {
  return { id, model_id: 'group-routing-model', name: id, priority: 0, weight: 1, strategy: 'random', enabled: 1, created_at: '', ...overrides };
}
function route(id: string, selectedGroup: RouteGroup | null = null, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id, model_id: 'group-routing-model', channel_id: id, upstream_model: id, group_id: selectedGroup?.id ?? null, group: selectedGroup,
    priority: 0, weight: 1, enabled: 1, input_price: null, output_price: null,
    channel: { id, name: id, kind: 'cloudflare', base_url: '', secret_encrypted: null, enabled: 1, timeout_ms: 60000, auto_create_routes: 1, created_at: '', provider_id: null, provider_slug: null, gateway_path: '', byok_alias: '' },
    ...overrides,
  };
}
async function ordered(candidates: Candidate[], strategy: GatewaySettings['load_balancing'] = 'weighted', random = () => 0, env = noDatabase) {
  const ids: string[] = [];
  for await (const candidate of iterateCandidates(env, candidates, random, strategy)) ids.push(candidate.id);
  return ids;
}
function seededRandom() {
  let seed = 17;
  return () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296);
}

describe('hierarchical route selection', () => {
  it('exhausts the primary group, including its lower route priorities, before a fallback group', async () => {
    const primary = group('primary'), fallback = group('fallback', { priority: 1, weight: 1000 });
    expect(await ordered([route('fallback-p0', fallback), route('primary-p2', primary, { priority: 2 }), route('primary-p0', primary)])).toEqual(['primary-p0', 'primary-p2', 'fallback-p0']);
  });

  it('uses group weights independently of route counts and route weights', async () => {
    const light = group('light'), heavy = group('heavy', { weight: 9 });
    const routes = [route('a', light, { weight: 1000 }), route('b', light, { weight: 1000 }), route('c', light, { weight: 1000 }), route('heavy', heavy)];
    expect((await ordered(routes, 'weighted', () => .5))[0]).toBe('heavy');
    expect(await ordered(routes, 'random', () => .1)).toEqual(['a', 'b', 'c', 'heavy']);
  });

  it('uses the selected group strategy inside equal route priorities', async () => {
    const weighted = group('weighted', { strategy: 'weighted' });
    const random = group('random', { strategy: 'random' });
    expect(await ordered([route('a', weighted), route('b', weighted, { weight: 99 })], 'random', () => .2)).toEqual(['b', 'a']);
    expect(await ordered([route('a', random), route('b', random, { weight: 99 })], 'weighted', () => .2)).toEqual(['a', 'b']);
  });

  it('never re-enters a channel through another route, priority, or group', async () => {
    const primary = group('primary'), fallback = group('fallback', { priority: 1 });
    const routes = [route('first', primary, { channel_id: 'same' }), route('duplicate', primary, { channel_id: 'same', priority: 1 }), route('cross-group-duplicate', fallback, { channel_id: 'same' }), route('backup', fallback)];
    expect(await ordered(routes)).toEqual(['first', 'backup']);
  });

  it('gives each explicit group route an equal random share even when two routes share a channel', async () => {
    const selected = group('random');
    const routes = [route('a', selected, { channel_id: 'same' }), route('b', selected, { channel_id: 'same' }), route('c', selected)];
    expect((await ordered(routes, 'weighted', () => .1))[0]).toBe('a');
    expect((await ordered(routes, 'weighted', () => .4))[0]).toBe('b');
    expect((await ordered(routes, 'weighted', () => .8))[0]).toBe('c');
    expect(await ordered(routes, 'weighted', () => .1)).toEqual(['a', 'c']);
  });

  it('excludes disabled groups', async () => {
    expect(await ordered([route('disabled', group('off', { enabled: 0 })), route('active', group('on', { priority: 1 }))])).toEqual(['active']);
  });

  it.each<GatewaySettings['load_balancing']>(['random', 'weighted'])('preserves ungrouped %s selection and channel deduplication', async strategy => {
    const routes = [route('a', null, { weight: 3 }), route('a-alias', null, { channel_id: 'a', weight: 9 }), route('b', null), route('c', null, { priority: 1, weight: 5 }), route('a-fallback', null, { channel_id: 'a', priority: 2 }), route('d', null, { priority: 3 })];
    expect(await ordered(routes, strategy, seededRandom())).toEqual(orderCandidates(routes, seededRandom(), strategy).map(candidate => candidate.id));
  });

  it('treats ungrouped routes as a P0 group of weight one', async () => {
    expect(await ordered([route('backup', group('backup', { priority: 1 })), route('legacy-high-route-priority', null, { priority: 9 })])).toEqual(['legacy-high-route-priority', 'backup']);
  });
});

describe('persistent round robin', () => {
  let mf: Miniflare, env: Env;
  beforeAll(async () => {
    mf = new Miniflare(convertV4MiniflareOptions({ name: 'group-routing-test', modules: true, script: 'export default { fetch() { return new Response("ok"); } }', compatibilityDate: '2026-09-01', d1Databases: ['DB'] }));
    const db = await mf.getD1Database('DB');
    env = { DB: db } as unknown as Env;
    for (const file of (await readdir('migrations')).filter(file => file.endsWith('.sql')).sort()) {
      const sql = (await readFile(`migrations/${file}`, 'utf8')).replace(/--[^\n]*/g, '');
      await db.batch(sql.split(';').filter(statement => statement.trim()).map(statement => db.prepare(statement)));
    }
    await env.DB.prepare("INSERT INTO models (id) VALUES ('group-routing-model')").run();
  });
  beforeEach(async () => { await env.DB.prepare('DELETE FROM route_groups').run(); });
  afterAll(async () => { await mf?.dispose(); });

  async function persistGroup(id: string, overrides: Partial<RouteGroup> = {}) {
    const selected = group(id, { strategy: 'round_robin', ...overrides });
    await env.DB.prepare('INSERT INTO route_groups (id, model_id, name, priority, weight, strategy, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(selected.id, selected.model_id, selected.name, selected.priority, selected.weight, selected.strategy, selected.enabled).run();
    return selected;
  }
  async function first(candidates: Candidate[]) {
    const iterator = iterateCandidates(env, candidates, () => 0);
    const result = (await iterator.next()).value;
    await iterator.return(undefined);
    return result?.id;
  }
  const cursors = async () => (await env.DB.prepare('SELECT group_id, priority, scope, position FROM route_group_cursors ORDER BY group_id, priority, scope').all<{ group_id: string; priority: number; scope: string; position: number }>()).results;

  it('rotates stable route IDs across requests and exhausts the current group before falling back', async () => {
    const primary = await persistGroup('primary'), backup = await persistGroup('backup', { priority: 1, strategy: 'random' });
    const routes = [route('c', primary), route('a', primary), route('b', primary), route('backup', backup)];
    expect(await ordered(routes, 'weighted', () => 0, env)).toEqual(['a', 'b', 'c', 'backup']);
    expect(await ordered(routes, 'weighted', () => 0, env)).toEqual(['b', 'c', 'a', 'backup']);
    expect(await ordered(routes, 'weighted', () => 0, env)).toEqual(['c', 'a', 'b', 'backup']);
    expect(await first(routes)).toBe('a');
  });

  it('does not allocate cursors for unreached groups or lower priority tiers', async () => {
    const primary = await persistGroup('primary'), backup = await persistGroup('backup', { priority: 1 });
    const iterator = iterateCandidates(env, [route('a', primary), route('b', primary), route('c', primary, { priority: 2 }), route('d', backup)], () => 0);
    expect((await iterator.next()).value?.id).toBe('a');
    expect((await cursors()).map(row => [row.group_id, row.priority, row.position])).toEqual([['primary', 0, 0]]);
    expect((await iterator.next()).value?.id).toBe('b');
    expect(await cursors()).toHaveLength(1);
    expect((await iterator.next()).value?.id).toBe('c');
    expect((await cursors()).map(row => [row.group_id, row.priority])).toEqual([['primary', 0], ['primary', 2]]);
    await iterator.return(undefined);
    expect((await cursors()).some(row => row.group_id === 'backup')).toBe(false);
  });

  it('isolates rotation for different authorized candidate sets', async () => {
    const selected = await persistGroup('primary');
    const a = route('a', selected), b = route('b', selected), c = route('c', selected);
    expect(await first([a, b])).toBe('a');
    expect(await first([b, c])).toBe('b');
    expect(await first([a, b])).toBe('b');
    expect(await first([b, c])).toBe('c');
    expect(await first([b, a])).toBe('a');
    expect(await cursors()).toHaveLength(2);
    expect((await cursors()).every(row => row.scope.length === 64)).toBe(true);
  });

  it('allocates concurrent requests atomically across independent iterators', async () => {
    const selected = await persistGroup('primary');
    const routes = [route('a', selected), route('b', selected), route('c', selected)];
    const results = await Promise.all(Array.from({ length: 30 }, () => first(routes)));
    expect(results.filter(id => id === 'a')).toHaveLength(10);
    expect(results.filter(id => id === 'b')).toHaveLength(10);
    expect(results.filter(id => id === 'c')).toHaveLength(10);
    expect(await cursors()).toHaveLength(1);
  });

  it('retains channel deduplication in round robin and skips already exhausted groups', async () => {
    const primary = await persistGroup('primary'), backup = await persistGroup('backup', { priority: 1 });
    const routes = [route('a', primary, { channel_id: 'same' }), route('b', primary, { channel_id: 'same' }), route('c', primary), route('d', backup, { channel_id: 'same' })];
    expect(await ordered(routes, 'weighted', () => 0, env)).toEqual(['a', 'c']);
    expect(await ordered(routes, 'weighted', () => 0, env)).toEqual(['b', 'c']);
    expect((await cursors()).map(row => row.group_id)).toEqual(['primary']);
  });
});
