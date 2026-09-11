import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

it('expands the timeout constraint while preserving channels, routes and cascading deletes', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'timeout-migration-test', modules: true, script: 'export default { fetch() { return new Response("ok"); } }', compatibilityDate: '2026-09-01', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    const migrate = async (file: string) => {
      const sql = (await readFile(`migrations/${file}`, 'utf8')).replace(/--[^\n]*/g, '');
      await db.batch(sql.split(';').filter(statement => statement.trim()).map(statement => db.prepare(statement)));
    };
    for (const file of ['0001_initial.sql', '0002_ai_gateway_control_plane.sql', '0003_protocols_and_tags.sql', '0004_gateway_settings.sql', '0005_channel_auto_routes.sql']) await migrate(file);
    await db.prepare(`INSERT INTO channels (id, name, kind, base_url, secret_encrypted, enabled, timeout_ms, provider_id, provider_slug, gateway_path, byok_alias, auto_create_routes)
      VALUES ('preserved', 'Existing channel', 'openai', 'https://example.com', 'encrypted-secret-fixture', 0, 120000, 'provider-1', 'provider', 'v1/messages', 'saved-alias', 0)`).run();
    await db.prepare(`INSERT INTO routes (id, model_id, channel_id, upstream_model, priority, weight, input_price, output_price, enabled, managed_by_provider)
      VALUES ('preserved-route', 'gpt-4.1', 'preserved', 'upstream-model', 3, 7, 0.5, 1.5, 0, 1)`).run();
    const channels = (await db.prepare('SELECT * FROM channels ORDER BY id').all()).results;
    const routes = (await db.prepare('SELECT * FROM routes ORDER BY id').all()).results;
    await migrate('0006_long_channel_timeout.sql');
    expect((await db.prepare('SELECT * FROM channels ORDER BY id').all()).results).toEqual(channels);
    expect((await db.prepare('SELECT * FROM routes ORDER BY id').all()).results).toEqual(routes);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('channels_provider', 'routes_model') ORDER BY name").all()).results).toEqual([{ name: 'channels_provider' }, { name: 'routes_model' }]);
    await db.prepare("UPDATE channels SET timeout_ms = 3600000 WHERE id = 'preserved'").run();
    await expect(db.prepare("UPDATE channels SET timeout_ms = 3600001 WHERE id = 'preserved'").run()).rejects.toThrow();
    await db.prepare("DELETE FROM channels WHERE id = 'preserved'").run();
    expect(await db.prepare("SELECT id FROM routes WHERE id = 'preserved-route'").first()).toBeNull();
    expect((await db.prepare('SELECT * FROM routes').all()).results).toHaveLength(3);
  } finally { await mf.dispose(); }
});
