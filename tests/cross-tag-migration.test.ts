import { expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

it('preserves existing routes and permissions while allowing independent cross-tag routes', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'cross-tag-migration-test', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }', compatibilityDate: '2026-09-01', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    const migrate = async (file: string) => {
      const sql = (await readFile(`migrations/${file}`, 'utf8')).replace(/--[^\n]*/g, '');
      await db.batch(sql.split(';').filter(statement => statement.trim()).map(statement => db.prepare(statement)));
    };
    for (const file of (await readdir('migrations')).filter(file => file.endsWith('.sql') && file < '0011').sort()) await migrate(file);
    await db.prepare("UPDATE routes SET priority = 3, weight = 7, enabled = 0, input_price = 0.5, output_price = 1.5, managed_by_provider = 1 WHERE id = 'rt_gpt'").run();
    await db.prepare(`INSERT INTO api_keys (id, name, key_hash, prefix, allowed_tags, allowed_models, token_encrypted)
      VALUES ('existing-key', 'Existing', 'hash', 'eg_old', '["AA"]', '["gpt-4.1"]', 'encrypted-fixture')`).run();
    await db.prepare("INSERT INTO key_counters (key_id, minute, minute_count, day, day_count) VALUES ('existing-key', 1, 2, 3, 4)").run();
    const routes = (await db.prepare('SELECT * FROM routes ORDER BY id').all()).results;
    const tables = ['channels', 'models', 'api_keys', 'key_counters', 'provider_profiles', 'gateway_settings', 'request_logs', 'upstream_error_traces'];
    const snapshot = () => Promise.all(tables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results));
    const before = await snapshot();

    await migrate('0011_cross_tag_routes.sql');

    expect((await db.prepare('SELECT * FROM routes ORDER BY id').all()).results).toEqual(routes.map(route => ({ ...route, scope_tag: '' })));
    expect(await snapshot()).toEqual(before);
    const insert = (id: string, scope: string) => db.prepare(`INSERT INTO routes (id, model_id, channel_id, upstream_model, scope_tag)
      VALUES (?, 'gpt-4.1', 'ch_cloudflare', 'openai/gpt-4.1', ?)`).bind(id, scope).run();
    await insert('a-cross', 'AA'); await insert('b-cross', 'BB');
    await expect(insert('duplicate-cross', 'AA')).rejects.toThrow();
    await expect(insert('duplicate-inherited', '')).rejects.toThrow();
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'routes_model'").first()).not.toBeNull();
    await db.prepare("DELETE FROM models WHERE id = 'gpt-4.1'").run();
    expect((await db.prepare("SELECT id FROM routes WHERE model_id = 'gpt-4.1'").all()).results).toEqual([]);
    await db.prepare("DELETE FROM channels WHERE id = 'ch_cloudflare'").run();
    expect((await db.prepare('SELECT * FROM routes').all()).results).toEqual([]);
  } finally { await mf.dispose(); }
});
