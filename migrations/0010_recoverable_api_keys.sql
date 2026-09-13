-- Keep hashes for authentication and encrypted originals for administrator access.
-- Existing hash-only credentials remain valid but cannot be recovered.
ALTER TABLE api_keys ADD COLUMN token_encrypted TEXT;
