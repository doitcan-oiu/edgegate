CREATE TABLE provider_profiles (
  provider_id TEXT PRIMARY KEY,
  protocol TEXT NOT NULL DEFAULT 'openai' CHECK(protocol IN ('openai', 'anthropic')),
  tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags)),
  models TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(models))
);
ALTER TABLE api_keys ADD COLUMN allowed_tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(allowed_tags));
ALTER TABLE routes ADD COLUMN managed_by_provider INTEGER NOT NULL DEFAULT 0;
