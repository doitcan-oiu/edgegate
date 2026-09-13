import { expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

it('adds encrypted token storage without replacing existing hashes, permissions or quota counters', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'api-key-migration-test', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }', compatibilityDate: '2026-09-01', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    const migrate = async (file: string) => {
      const sql = (await readFile(`migrations/${file}`, 'utf8')).replace(/--[^\n]*/g, '');
      await db.batch(sql.split(';').filter(statement => statement.trim()).map(statement => db.prepare(statement)));
    };
    for (const file of (await readdir('migrations')).filter(file => /^000\d_.*\.sql$/.test(file)).sort()) await migrate(file);
    await db.prepare(`INSERT INTO api_keys (id, name, key_hash, prefix, allowed_models, allowed_tags, rpm, daily_limit, expires_at, revoked_at)
      VALUES ('legacy-key', 'Existing key', 'existing-hash', 'eg_existing', '["gpt-4.1"]', '["AA"]', 123, 4567, '2027-01-01T00:00:00.000Z', '2026-09-12T10:00:00.000Z')`).run();
    await db.prepare(`INSERT INTO key_counters (key_id, minute, minute_count, day, day_count) VALUES ('legacy-key', 10, 3, 4, 100)`).run();
    const before = (await db.prepare('SELECT * FROM api_keys').all()).results;
    const preservedTables = ['key_counters', 'channels', 'models', 'routes', 'provider_profiles', 'gateway_settings', 'request_logs', 'upstream_error_traces'];
    const snapshot = async () => Promise.all(preservedTables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results));
    const preserved = await snapshot();

    await migrate('0010_recoverable_api_keys.sql');

    expect((await db.prepare('SELECT * FROM api_keys').all()).results).toEqual(before.map(row => ({ ...row, token_encrypted: null })));
    expect(await snapshot()).toEqual(preserved);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    await db.prepare('UPDATE api_keys SET token_encrypted = ? WHERE id = ?').bind('encrypted-fixture', 'legacy-key').run();
    expect(await db.prepare('SELECT key_hash, token_encrypted FROM api_keys WHERE id = ?').bind('legacy-key').first()).toEqual({ key_hash: 'existing-hash', token_encrypted: 'encrypted-fixture' });
  } finally { await mf.dispose(); }
});
