CREATE TABLE gateway_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE upstream_error_traces (
  request_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  cf_log_id TEXT,
  status INTEGER,
  error_code TEXT NOT NULL,
  error_body TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (request_id, attempt)
);
CREATE INDEX upstream_error_traces_cf_log ON upstream_error_traces(cf_log_id) WHERE cf_log_id IS NOT NULL;
CREATE INDEX upstream_error_traces_created ON upstream_error_traces(created_at);
PRAGMA optimize;
