-- Expand the protocol CHECK without modifying existing profiles or channel data.
-- provider_profiles has no inbound foreign keys. Channel links use provider IDs.
CREATE TABLE provider_profiles_responses (
  provider_id TEXT PRIMARY KEY,
  protocol TEXT NOT NULL DEFAULT 'openai' CHECK(protocol IN ('openai', 'anthropic', 'responses')),
  tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags)),
  models TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(models))
);
INSERT INTO provider_profiles_responses (provider_id, protocol, tags, models)
  SELECT provider_id, protocol, tags, models FROM provider_profiles;
DROP TABLE provider_profiles;
ALTER TABLE provider_profiles_responses RENAME TO provider_profiles;
