-- Preserve existing configuration and historical logs. New requests are logged by AI Gateway only.
ALTER TABLE channels ADD COLUMN provider_id TEXT;
ALTER TABLE channels ADD COLUMN provider_slug TEXT;
ALTER TABLE channels ADD COLUMN gateway_path TEXT NOT NULL DEFAULT 'chat/completions';
ALTER TABLE channels ADD COLUMN byok_alias TEXT NOT NULL DEFAULT '';
CREATE INDEX channels_provider ON channels(provider_id);
-- The legacy kind 'openai' now denotes an AI Gateway custom provider channel.
-- Existing direct channels remain unconfigured until explicitly linked to a Cloudflare provider.
