-- Mirror CF upstream attempts separately from legacy request_logs.
CREATE TABLE observability_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  log_retention_days INTEGER NOT NULL DEFAULT 7 CHECK (log_retention_days IN (7, 30))
);
INSERT INTO observability_settings (id) VALUES (1);

CREATE TABLE observability_jobs (
  scope TEXT NOT NULL,
  job TEXT NOT NULL,
  cursor TEXT,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  requested_seq INTEGER NOT NULL DEFAULT 0,
  handled_seq INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  PRIMARY KEY (scope, job)
);
CREATE TABLE observability_snapshots (
  scope TEXT NOT NULL,
  range TEXT NOT NULL CHECK (range IN ('24h', '7d')),
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, range)
);
CREATE TABLE observability_logs (
  scope TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  success INTEGER NOT NULL,
  upstream_model TEXT NOT NULL,
  payload TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  observed_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, id)
);
CREATE INDEX observability_logs_time ON observability_logs(scope, created_at DESC, id DESC);
CREATE INDEX observability_logs_status_time ON observability_logs(scope, success, created_at DESC, id DESC);
CREATE INDEX observability_logs_model_time ON observability_logs(scope, upstream_model, created_at DESC, id DESC);
CREATE INDEX observability_logs_retention ON observability_logs(created_at);
PRAGMA optimize;
