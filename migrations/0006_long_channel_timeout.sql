-- Rebuild the original CHECK constraint without changing channel IDs or secrets.
-- D1 keeps ON DELETE CASCADE active during migrations, so preserve routes first.
CREATE TABLE channels_long_timeout (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('cloudflare', 'ai-gateway', 'openai')),
  base_url TEXT NOT NULL DEFAULT '',
  secret_encrypted TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  timeout_ms INTEGER NOT NULL DEFAULT 60000 CHECK(timeout_ms BETWEEN 1000 AND 3600000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  provider_id TEXT,
  provider_slug TEXT,
  gateway_path TEXT NOT NULL DEFAULT 'chat/completions',
  byok_alias TEXT NOT NULL DEFAULT '',
  auto_create_routes INTEGER NOT NULL DEFAULT 1 CHECK(auto_create_routes IN (0, 1))
);
INSERT INTO channels_long_timeout (id, name, kind, base_url, secret_encrypted, enabled, timeout_ms, created_at, provider_id, provider_slug, gateway_path, byok_alias, auto_create_routes)
  SELECT id, name, kind, base_url, secret_encrypted, enabled, timeout_ms, created_at, provider_id, provider_slug, gateway_path, byok_alias, auto_create_routes FROM channels;
CREATE TABLE routes_timeout_backup AS SELECT * FROM routes;
DROP TABLE channels;
ALTER TABLE channels_long_timeout RENAME TO channels;
CREATE INDEX channels_provider ON channels(provider_id);
INSERT INTO routes (id, model_id, channel_id, upstream_model, priority, weight, input_price, output_price, enabled, managed_by_provider)
  SELECT id, model_id, channel_id, upstream_model, priority, weight, input_price, output_price, enabled, managed_by_provider FROM routes_timeout_backup;
DROP TABLE routes_timeout_backup;
