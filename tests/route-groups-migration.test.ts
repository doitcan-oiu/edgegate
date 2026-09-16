import { expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

it('preserves existing routes, tag grants, credentials and indexes when adding route groups', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'route-groups-preservation-test', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }', compatibilityDate: '2026-09-01', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    const migrate = async (file: string) => {
      const sql = (await readFile(`migrations/${file}`, 'utf8')).replace(/--[^\n]*/g, '');
      await db.batch(sql.split(';').filter(statement => statement.trim()).map(statement => db.prepare(statement)));
    };
    for (const file of (await readdir('migrations')).filter(file => file.endsWith('.sql') && file < '0012').sort()) await migrate(file);
    await db.prepare(`INSERT INTO provider_profiles (provider_id, protocol, tags, models)
      VALUES ('preserved-provider', 'anthropic', '["BB"]', '["claude-opus-4-6"]')`).run();
    await db.prepare(`INSERT INTO channels (id, name, kind, base_url, secret_encrypted, enabled, timeout_ms, provider_id, provider_slug, gateway_path, byok_alias, auto_create_routes)
      VALUES ('preserved-channel', 'Existing channel', 'openai', 'https://example.com', 'encrypted-secret-fixture', 0, 3600000, 'preserved-provider', 'provider', 'v1/messages', 'saved-alias', 0)`).run();
    // Older SQL allowed values beyond today's API limits; migration must preserve them too.
    await db.prepare(`INSERT INTO routes (id, model_id, channel_id, upstream_model, priority, weight, input_price, output_price, enabled, managed_by_provider, scope_tag)
      VALUES ('preserved-cross-tag', 'gpt-4.1', 'preserved-channel', 'claude-opus-4-6', -1, 1500, 0.5, 1.5, 0, 1, 'AA')`).run();
    await db.prepare(`INSERT INTO api_keys (id, name, key_hash, prefix, allowed_tags, allowed_models, token_encrypted)
      VALUES ('preserved-key', 'Existing', 'hash', 'eg_old', '["AA"]', '["gpt-4.1"]', 'encrypted-token-fixture')`).run();
    await db.prepare("INSERT INTO key_counters (key_id, minute, minute_count, day, day_count) VALUES ('preserved-key', 1, 2, 3, 4)").run();
    await db.prepare(`INSERT INTO gateway_settings (id, value) VALUES (1, '{"load_balancing":"weighted","cross_channel_retries":4}')`).run();
    await db.prepare(`INSERT INTO request_logs (id, key_id, model, channel_id, status, latency_ms)
      VALUES ('preserved-log', 'preserved-key', 'gpt-4.1', 'preserved-channel', 200, 15)`).run();
    await db.prepare(`INSERT INTO upstream_error_traces (request_id, attempt, channel_id, channel_name, upstream_model, error_code, error_body)
      VALUES ('preserved-error', 1, 'preserved-channel', 'Existing channel', 'claude-opus-4-6', 'upstream_error', 'fixture error')`).run();
    const routes = (await db.prepare('SELECT * FROM routes ORDER BY id').all()).results;
    const tables = ['channels', 'models', 'api_keys', 'key_counters', 'provider_profiles', 'gateway_settings', 'request_logs', 'upstream_error_traces'];
    const snapshot = () => Promise.all(tables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results));
    const before = await snapshot();
    const indexes = (await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all()).results;

    await migrate('0012_route_groups.sql');

    expect((await db.prepare('SELECT * FROM routes ORDER BY id').all()).results).toEqual(routes.map(route => ({ ...route, group_id: null })));
    expect(await snapshot()).toEqual(before);
    expect((await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all()).results).toEqual(expect.arrayContaining(indexes));
    expect((await db.prepare('SELECT * FROM route_groups').all()).results).toEqual([]);
    expect((await db.prepare('SELECT * FROM route_group_cursors').all()).results).toEqual([]);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  } finally { await mf.dispose(); }
});

it('enforces group constraints and preserves route uniqueness, cursor isolation and cascading deletes', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'route-groups-constraints-test', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }', compatibilityDate: '2026-09-01', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    for (const file of (await readdir('migrations')).filter(file => file.endsWith('.sql') && file <= '0012_route_groups.sql').sort()) {
      const sql = (await readFile(`migrations/${file}`, 'utf8')).replace(/--[^\n]*/g, '');
      await db.batch(sql.split(';').filter(statement => statement.trim()).map(statement => db.prepare(statement)));
    }
    await db.prepare("INSERT INTO route_groups (id, model_id, name) VALUES ('group-a', 'gpt-4.1', 'Primary')").run();
    expect(await db.prepare("SELECT priority, weight, strategy, enabled, created_at FROM route_groups WHERE id = 'group-a'").first()).toEqual({
      priority: 0, weight: 1, strategy: 'random', enabled: 1, created_at: expect.any(String),
    });
    await db.prepare("INSERT INTO route_groups (id, model_id, name, priority, weight, strategy, enabled) VALUES ('group-b', 'gpt-4.1', 'Fallback', 1000, 1000, 'weighted', 0)").run();
    await db.prepare("UPDATE route_groups SET strategy = 'round_robin' WHERE id = 'group-a'").run();
    for (const [field, value] of [['priority', -1], ['priority', 1001], ['weight', 0], ['weight', 1001], ['strategy', 'unknown'], ['enabled', 2]] as const) {
      await expect(db.prepare(`UPDATE route_groups SET ${field} = ? WHERE id = 'group-a'`).bind(value).run()).rejects.toThrow();
    }
    await expect(db.prepare("INSERT INTO route_groups (id, model_id, name) VALUES ('invalid-model', 'missing-model', 'Invalid')").run()).rejects.toThrow();
    await expect(db.prepare("UPDATE routes SET group_id = 'missing-group' WHERE id = 'rt_gpt'").run()).rejects.toThrow();
    await db.prepare("UPDATE routes SET group_id = 'group-a' WHERE id = 'rt_gpt'").run();
    const insertRoute = (id: string, tag: string, group: string | null) => db.prepare(`INSERT INTO routes (id, model_id, channel_id, upstream_model, scope_tag, group_id)
      VALUES (?, 'gpt-4.1', 'ch_cloudflare', 'openai/gpt-4.1', ?, ?)`).bind(id, tag, group).run();
    await insertRoute('route-aa', 'AA', 'group-a');
    await insertRoute('route-bb', 'BB', 'group-b');
    await expect(insertRoute('duplicate-inherited', '', 'group-b')).rejects.toThrow();
    await expect(insertRoute('duplicate-explicit', 'AA', 'group-b')).rejects.toThrow();
    await expect(insertRoute('duplicate-ungrouped', 'AA', null)).rejects.toThrow();

    const cursor = (group: string, priority: number, scope: string, position: number) => db.prepare(`INSERT INTO route_group_cursors (group_id, priority, scope, position)
      VALUES (?, ?, ?, ?)`).bind(group, priority, scope, position).run();
    await cursor('group-a', 0, 'authorized-aa', 2);
    await cursor('group-a', 0, 'authorized-bb', 3);
    await cursor('group-a', 1, 'authorized-aa', 4);
    await expect(cursor('group-a', 0, 'authorized-aa', 9)).rejects.toThrow();
    await expect(cursor('missing-group', 0, '', 0)).rejects.toThrow();
    await db.prepare("INSERT INTO route_group_cursors (group_id, priority, position) VALUES ('group-b', 0, 5)").run();
    expect(await db.prepare("SELECT scope FROM route_group_cursors WHERE group_id = 'group-b'").first()).toEqual({ scope: '' });
    expect((await db.prepare("SELECT scope, priority, position FROM route_group_cursors WHERE group_id = 'group-a' ORDER BY scope, priority").all()).results).toEqual([
      { scope: 'authorized-aa', priority: 0, position: 2 }, { scope: 'authorized-aa', priority: 1, position: 4 }, { scope: 'authorized-bb', priority: 0, position: 3 },
    ]);

    // The API rejects deletion of nonempty groups; the FK still must safely handle direct SQL deletes.
    await db.prepare("DELETE FROM route_groups WHERE id = 'group-a'").run();
    expect((await db.prepare("SELECT id, group_id FROM routes WHERE id IN ('rt_gpt', 'route-aa') ORDER BY id").all()).results).toEqual([
      { id: 'route-aa', group_id: null }, { id: 'rt_gpt', group_id: null },
    ]);
    expect((await db.prepare("SELECT * FROM route_group_cursors WHERE group_id = 'group-a'").all()).results).toEqual([]);
    expect(await db.prepare("SELECT group_id FROM routes WHERE id = 'route-bb'").first()).toEqual({ group_id: 'group-b' });
    await db.prepare("DELETE FROM models WHERE id = 'gpt-4.1'").run();
    expect((await db.prepare("SELECT id FROM routes WHERE model_id = 'gpt-4.1'").all()).results).toEqual([]);
    expect((await db.prepare("SELECT id FROM route_groups WHERE model_id = 'gpt-4.1'").all()).results).toEqual([]);
    expect((await db.prepare('SELECT * FROM route_group_cursors').all()).results).toEqual([]);

    await db.prepare("INSERT INTO route_groups (id, model_id, name) VALUES ('surviving-group', 'claude-sonnet-4', 'Channel independent')").run();
    await db.prepare("UPDATE routes SET group_id = 'surviving-group' WHERE id = 'rt_claude'").run();
    await db.prepare("DELETE FROM channels WHERE id = 'ch_cloudflare'").run();
    expect((await db.prepare('SELECT * FROM routes').all()).results).toEqual([]);
    expect(await db.prepare("SELECT id FROM route_groups WHERE id = 'surviving-group'").first()).not.toBeNull();
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  } finally { await mf.dispose(); }
});
