import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

it('removes populated observability caches while preserving business data, quotas and historical diagnostics', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'observability-migration-test', modules: true, script: 'export default { fetch() { return new Response("ok"); } }', compatibilityDate: '2026-09-01', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    const migrate = async (file: string) => {
      const sql = (await readFile(`migrations/${file}`, 'utf8')).replace(/--[^\n]*/g, '');
      await db.batch(sql.split(';').filter(statement => statement.trim()).map(statement => db.prepare(statement)));
    };
    for (const file of ['0001_initial.sql', '0002_ai_gateway_control_plane.sql', '0003_protocols_and_tags.sql', '0004_gateway_settings.sql', '0005_channel_auto_routes.sql', '0006_long_channel_timeout.sql', '0007_observability_cache.sql', '0008_responses_protocol.sql']) await migrate(file);

    await db.batch([
      `INSERT INTO provider_profiles (provider_id, protocol, tags, models)
        VALUES ('preserved-provider', 'responses', '["production"]', '["gpt-4.1"]')`,
      `INSERT INTO channels (id, name, kind, base_url, secret_encrypted, enabled, timeout_ms, provider_id, provider_slug, gateway_path, byok_alias, auto_create_routes)
        VALUES ('preserved-channel', 'Existing channel', 'openai', 'https://example.com', 'encrypted-secret-fixture', 0, 1200000, 'preserved-provider', 'provider', 'v1/responses', 'saved-alias', 0)`,
      `INSERT INTO routes (id, model_id, channel_id, upstream_model, priority, weight, input_price, output_price, enabled, managed_by_provider)
        VALUES ('preserved-route', 'gpt-4.1', 'preserved-channel', 'upstream-model', 3, 7, 0.5, 1.5, 0, 1)`,
      `INSERT INTO api_keys (id, name, key_hash, prefix, allowed_models, allowed_tags, rpm, daily_limit, expires_at)
        VALUES ('preserved-key', 'Existing key', 'fixture-key-hash', 'eg_fixture', '["gpt-4.1"]', '["production"]', 120, 5000, '2027-01-01T00:00:00.000Z')`,
      `INSERT INTO key_counters (key_id, minute, minute_count, day, day_count)
        VALUES ('preserved-key', 1000, 17, 7, 1234)`,
      `INSERT INTO gateway_settings (id, value, updated_at)
        VALUES (1, '{"retries":2}', '2026-09-12T10:00:00.000Z')`,
      `INSERT INTO request_logs (id, key_id, model, channel_id, upstream_model, status, latency_ms, input_tokens, output_tokens, cost_usd, cached, stream, attempts, error_code, created_at)
        VALUES ('legacy-log', 'preserved-key', 'gpt-4.1', 'preserved-channel', 'upstream-model', 502, 123, 12, 3, 0.25, 0, 1, 2, 'upstream_error', '2026-09-12T10:01:00.000Z')`,
      `INSERT INTO upstream_error_traces (request_id, attempt, channel_id, channel_name, upstream_model, cf_log_id, status, error_code, error_body, truncated, created_at)
        VALUES ('preserved-request', 1, 'preserved-channel', 'Existing channel', 'upstream-model', 'cached-cf-log', 503, 'upstream_error', '{"message":"upstream unavailable"}', 0, '2026-09-12T10:02:00.000Z')`,
      `UPDATE observability_settings SET log_retention_days = 30 WHERE id = 1`,
      `INSERT INTO observability_jobs (scope, job, cursor, next_run_at, requested_seq, handled_seq, lease_owner, lease_until, last_attempt_at, last_success_at, last_error)
        VALUES ('account/gateway', 'logs', 'saved-cursor', 100, 4, 3, 'worker', 200, '2026-09-12T10:00:00.000Z', '2026-09-12T09:59:00.000Z', 'cached failure')`,
      `INSERT INTO observability_snapshots (scope, range, payload, updated_at)
        VALUES ('account/gateway', '24h', '{"requests":10}', '2026-09-12T10:00:00.000Z')`,
      `INSERT INTO observability_logs (scope, id, created_at, success, upstream_model, payload, synced_at, observed_at)
        VALUES ('account/gateway', 'cached-cf-log', '2026-09-12T10:02:00.000Z', 0, 'upstream-model', '{"status":503}', '2026-09-12T10:03:00.000Z', 100)`,
    ].map(statement => db.prepare(statement)));

    const cacheTables = ['observability_settings', 'observability_jobs', 'observability_snapshots', 'observability_logs'];
    for (const table of cacheTables) {
      expect(await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).toEqual({ count: 1 });
    }
    const businessTables = ['channels', 'models', 'routes', 'api_keys', 'key_counters', 'provider_profiles', 'gateway_settings', 'request_logs', 'upstream_error_traces'];
    const snapshot = async () => Promise.all(businessTables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()).results));
    const before = await snapshot();
    before.forEach(rows => expect(rows.length).toBeGreaterThan(0));
    const schema = async () => (await db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND tbl_name NOT IN (?, ?, ?, ?) ORDER BY type, name`).bind(...cacheTables).all()).results;
    const preservedSchema = await schema();
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);

    // Reapplying the cleanup must remain safe for databases where the caches are already gone.
    for (let run = 0; run < 2; run++) {
      await migrate('0009_remove_observability_cache.sql');
      expect((await db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'observability_%'").all()).results).toEqual([]);
      for (const table of cacheTables) await expect(db.prepare(`SELECT * FROM ${table}`).all()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(await schema()).toEqual(preservedSchema);
      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    }
  } finally { await mf.dispose(); }
});
