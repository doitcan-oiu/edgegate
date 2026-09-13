-- Empty scope_tag preserves the existing channel-tag authorization behavior.
-- An explicit tag grants access only through that tag, independently of the channel.
CREATE TABLE routes_scoped (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  upstream_model TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1 CHECK(weight > 0),
  input_price REAL CHECK(input_price >= 0),
  output_price REAL CHECK(output_price >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  managed_by_provider INTEGER NOT NULL DEFAULT 0,
  scope_tag TEXT NOT NULL DEFAULT '' CHECK(length(scope_tag) <= 40),
  UNIQUE(model_id, channel_id, upstream_model, scope_tag)
);
INSERT INTO routes_scoped (id, model_id, channel_id, upstream_model, priority, weight, input_price, output_price, enabled, managed_by_provider)
  SELECT id, model_id, channel_id, upstream_model, priority, weight, input_price, output_price, enabled, managed_by_provider FROM routes;
DROP TABLE routes;
ALTER TABLE routes_scoped RENAME TO routes;
CREATE INDEX routes_model ON routes(model_id, enabled, priority);
