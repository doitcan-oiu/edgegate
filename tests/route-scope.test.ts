import { describe, expect, it } from 'vitest';
import { routeScopeTags, scopeModels } from '../shared/route-scope';
import { availablePlaygroundModels } from '../src/playground';
import type { RouteGroup } from '../shared/routing';

const channels = [
  { id: 'a', tags: ['AA'], enabled: 1, configured: true },
  { id: 'b', tags: ['BB'], enabled: 1, configured: true },
  { id: 'u', tags: [], enabled: 1, configured: true },
];
const models = [{ id: 'gpt5.6-sol', enabled: 1, routes: [
  { id: 'a', channel_id: 'a', enabled: 1, scope_tag: '' },
  { id: 'b', channel_id: 'b', enabled: 1, scope_tag: '' },
  { id: 'cross', channel_id: 'b', enabled: 1, scope_tag: 'AA' },
  { id: 'untagged-cross', channel_id: 'u', enabled: 1, scope_tag: 'AA' },
] }];

describe('model directory and Playground route scopes', () => {
  it('shows explicit routes under their owning tag while keeping channel tags separate', () => {
    expect(scopeModels(models, channels, { kind: 'tag', tag: 'AA' })[0].routes.map(r => r.id)).toEqual(['a', 'cross', 'untagged-cross']);
    expect(scopeModels(models, channels, { kind: 'tag', tag: 'BB' })[0].routes.map(r => r.id)).toEqual(['b']);
    expect(scopeModels(models, channels, { kind: 'untagged' })).toEqual([]);
    expect(scopeModels(models, channels, { kind: 'tag', tag: 'unknown' })).toEqual([]);
    expect(models[0].routes).toHaveLength(4);
  });
  it('retains explicit tags after their original channel tag is removed', () => {
    const changed = channels.map(c => ({ ...c, tags: ['RENAMED'] }));
    expect(routeScopeTags(models, changed)).toEqual(['AA', 'RENAMED']);
    expect(scopeModels(models, changed, { kind: 'tag', tag: 'AA' })[0].routes.map(r => r.id)).toEqual(['cross', 'untagged-cross']);
  });
  it('lets Playground use the explicit upstream only when the model, route and channel are callable', () => {
    const alias = [{ id: 'a-alias', enabled: 1, routes: [models[0].routes[2]] }];
    const scope = { kind: 'tag', tag: 'AA' } as const;
    expect(availablePlaygroundModels(alias, channels, scope)).toEqual(alias);
    expect(availablePlaygroundModels(alias, channels, { kind: 'tag', tag: 'BB' })).toEqual([]);
    expect(availablePlaygroundModels(alias, channels.map(c => ({ ...c, enabled: 0 })), scope)).toEqual([]);
    expect(availablePlaygroundModels(alias, channels.map(c => ({ ...c, configured: false })), scope)).toEqual([]);
    expect(availablePlaygroundModels([{ ...alias[0], enabled: 0 }], channels, scope)).toEqual([]);
    expect(availablePlaygroundModels([{ ...alias[0], routes: [{ ...alias[0].routes[0], enabled: 0 }] }], channels, scope)).toEqual([]);
    expect(availablePlaygroundModels(alias, [], scope)).toEqual([]);
  });
  it('keeps empty global groups visible while hiding groups whose routes belong only to other tags', () => {
    const grouped = [{ ...models[0], routes: [{ ...models[0].routes[1], group_id: 'b-group' }], groups: [
      { id: 'empty', route_count: 0 }, { id: 'b-group', route_count: 1 },
    ] }];
    const scoped = scopeModels(grouped, channels, { kind: 'tag', tag: 'AA' });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].routes).toEqual([]);
    expect(scoped[0].groups).toEqual([{ id: 'empty', route_count: 0 }]);
    expect(scopeModels(grouped, channels, { kind: 'tag', tag: 'BB' })[0].groups).toHaveLength(2);
  });
  it('excludes disabled or missing groups from Playground without hiding them from administration', () => {
    const group: RouteGroup = { id: 'g', model_id: 'gpt5.6-sol', name: 'Group', priority: 0, weight: 1, strategy: 'random', enabled: 0, created_at: '' };
    const grouped = [{ ...models[0], routes: [{ ...models[0].routes[0], group_id: 'g' }], groups: [group] }];
    const scope = { kind: 'tag', tag: 'AA' } as const;
    expect(scopeModels(grouped, channels, scope)[0].groups).toEqual([group]);
    expect(availablePlaygroundModels(grouped, channels, scope)).toEqual([]);
    expect(availablePlaygroundModels([{ ...grouped[0], groups: [] }], channels, scope)).toEqual([]);
    expect(availablePlaygroundModels([{ ...grouped[0], groups: [{ ...group, enabled: 1 }] }], channels, scope)).toHaveLength(1);
  });
});
