PRAGMA foreign_keys = ON;

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('cloudflare', 'ai-gateway', 'openai')),
  base_url TEXT NOT NULL DEFAULT '',
  secret_encrypted TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  timeout_ms INTEGER NOT NULL DEFAULT 60000 CHECK(timeout_ms BETWEEN 1000 AND 120000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE models (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE routes (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  upstream_model TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1 CHECK(weight > 0),
  input_price REAL CHECK(input_price >= 0),
  output_price REAL CHECK(output_price >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  UNIQUE(model_id, channel_id, upstream_model)
);
CREATE INDEX routes_model ON routes(model_id, enabled, priority);
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  allowed_models TEXT NOT NULL DEFAULT '[]',
  rpm INTEGER NOT NULL DEFAULT 60 CHECK(rpm BETWEEN 1 AND 10000),
  daily_limit INTEGER NOT NULL DEFAULT 0 CHECK(daily_limit >= 0),
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE key_counters (
  key_id TEXT PRIMARY KEY,
  minute INTEGER NOT NULL,
  minute_count INTEGER NOT NULL,
  day INTEGER NOT NULL,
  day_count INTEGER NOT NULL
);
CREATE TABLE request_logs (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  channel_id TEXT,
  upstream_model TEXT,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  cached INTEGER NOT NULL DEFAULT 0,
  stream INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX logs_created ON request_logs(created_at DESC);
CREATE INDEX logs_key_created ON request_logs(key_id, created_at DESC);
CREATE INDEX logs_model_created ON request_logs(model, created_at DESC);

INSERT INTO channels (id, name, kind) VALUES ('ch_cloudflare', 'Cloudflare AI', 'cloudflare');
INSERT INTO models (id, description) VALUES
  ('gpt-4.1', '通用推理与代码任务'),
  ('claude-sonnet-4', '长文本分析与复杂任务'),
  ('llama-3.3-70b', 'Cloudflare Workers AI 托管模型');
INSERT INTO routes (id, model_id, channel_id, upstream_model) VALUES
  ('rt_gpt', 'gpt-4.1', 'ch_cloudflare', 'openai/gpt-4.1'),
  ('rt_claude', 'claude-sonnet-4', 'ch_cloudflare', 'anthropic/claude-sonnet-4'),
  ('rt_llama', 'llama-3.3-70b', 'ch_cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
