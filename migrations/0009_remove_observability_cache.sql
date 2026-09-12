-- Observability now reads Cloudflare directly. Remove only the retired cache.
-- Business configuration, quotas, legacy logs and upstream error traces remain.
DROP TABLE IF EXISTS observability_logs;
DROP TABLE IF EXISTS observability_snapshots;
DROP TABLE IF EXISTS observability_jobs;
DROP TABLE IF EXISTS observability_settings;
