import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

it('adds Responses profiles while preserving existing profiles, channels, secrets, routes and keys', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'responses-migration-test', modules: true, script: 'export default { fetch() { return new Response("ok"); } }', compatibilityDate: '2026-09-01', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    const migrate = async (file: string) => {
      const sql = (await readFile(`migrations/${file}`, 'utf8')).replace(/--[^\n]*/g, '');
      await db.batch(sql.split(';').filter(statement => statement.trim()).map(statement => db.prepare(statement)));
    };
    for (const file of ['0001_initial.sql', '0002_ai_gateway_control_plane.sql', '0003_protocols_and_tags.sql', '0004_gateway_settings.sql', '0005_channel_auto_routes.sql', '0006_long_channel_timeout.sql', '0007_observability_cache.sql']) await migrate(file);
    await db.prepare(`INSERT INTO provider_profiles (provider_id, protocol, tags, models) VALUES
      ('provider-chat', 'openai', '["AA","共享"]', '["gpt-4.1","alias/model"]'),
      ('provider-messages', 'anthropic', '["BB"]', '["claude-sonnet-4"]')`).run();
    await db.prepare(`INSERT INTO channels (id, name, kind, base_url, secret_encrypted, enabled, timeout_ms, provider_id, provider_slug, gateway_path, byok_alias, auto_create_routes)
      VALUES ('preserved-responses', 'Existing custom channel', 'openai', 'https://example.com', 'encrypted-secret-fixture', 0, 1200000, 'provider-messages', 'messages', 'v1/messages', 'saved-alias', 0)`).run();
    await db.prepare(`INSERT INTO routes (id, model_id, channel_id, upstream_model, priority, weight, input_price, output_price, enabled, managed_by_provider)
      VALUES ('preserved-responses-route', 'gpt-4.1', 'preserved-responses', 'upstream-model', 3, 7, 0.5, 1.5, 0, 1)`).run();
    await db.prepare(`INSERT INTO api_keys (id, name, key_hash, prefix, allowed_models, allowed_tags)
      VALUES ('preserved-key', 'Existing key', 'fixture-key-hash', 'eg_fixture', '["gpt-4.1"]', '["AA"]')`).run();
    const tables = ['provider_profiles', 'channels', 'routes', 'api_keys', 'models'] as const;
    const before = await Promise.all(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'provider_profiles' ? 'provider_id' : 'id'}`).all()));
    await expect(db.prepare("INSERT INTO provider_profiles (provider_id, protocol) VALUES ('not-yet-allowed', 'responses')").run()).rejects.toThrow();

    await migrate('0008_responses_protocol.sql');

    for (const [index, table] of tables.entries()) {
      expect((await db.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'provider_profiles' ? 'provider_id' : 'id'}`).all()).results).toEqual(before[index].results);
    }
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('channels_provider', 'routes_model') ORDER BY name").all()).results).toEqual([{ name: 'channels_provider' }, { name: 'routes_model' }]);
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'provider_profiles_responses'").first()).toBeNull();

    await db.prepare("INSERT INTO provider_profiles (provider_id, protocol, tags, models) VALUES ('provider-responses', 'responses', '[\"CC\"]', '[\"gpt-4.1\"]')").run();
    await db.prepare("UPDATE provider_profiles SET protocol = 'responses' WHERE provider_id = 'provider-chat'").run();
    expect(await db.prepare("SELECT protocol FROM provider_profiles WHERE provider_id = 'provider-chat'").first()).toEqual({ protocol: 'responses' });
    await db.prepare("INSERT INTO provider_profiles (provider_id) VALUES ('defaults-preserved')").run();
    expect(await db.prepare("SELECT protocol, tags, models FROM provider_profiles WHERE provider_id = 'defaults-preserved'").first()).toEqual({ protocol: 'openai', tags: '[]', models: '[]' });
    await expect(db.prepare("INSERT INTO provider_profiles (provider_id, protocol) VALUES ('invalid-protocol', 'unknown')").run()).rejects.toThrow();
    await expect(db.prepare("UPDATE provider_profiles SET tags = 'invalid-json' WHERE provider_id = 'provider-responses'").run()).rejects.toThrow();
    await expect(db.prepare("UPDATE provider_profiles SET models = 'invalid-json' WHERE provider_id = 'provider-responses'").run()).rejects.toThrow();
    await expect(db.prepare("INSERT INTO provider_profiles (provider_id) VALUES ('provider-responses')").run()).rejects.toThrow();
    await db.prepare("DELETE FROM channels WHERE id = 'preserved-responses'").run();
    expect(await db.prepare("SELECT id FROM routes WHERE id = 'preserved-responses-route'").first()).toBeNull();
    expect(await db.prepare("SELECT provider_id FROM provider_profiles WHERE provider_id = 'provider-messages'").first()).toEqual({ provider_id: 'provider-messages' });
  } finally { await mf.dispose(); }
});
