CREATE TABLE route_groups (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 1000),
  weight INTEGER NOT NULL DEFAULT 1 CHECK(weight BETWEEN 1 AND 1000),
  strategy TEXT NOT NULL DEFAULT 'random' CHECK(strategy IN ('random', 'weighted', 'round_robin')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX route_groups_model ON route_groups(model_id, enabled, priority);

-- Existing routes remain in the implicit default group with their original settings.
ALTER TABLE routes ADD COLUMN group_id TEXT REFERENCES route_groups(id) ON DELETE SET NULL;
CREATE INDEX routes_group ON routes(group_id);

-- Each authorized candidate set has an independent atomic round-robin cursor.
CREATE TABLE route_group_cursors (
  group_id TEXT NOT NULL REFERENCES route_groups(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(group_id, priority, scope)
);
