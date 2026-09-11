-- Keep existing channels on automatic catalog routing. New channels can opt out.
ALTER TABLE channels ADD COLUMN auto_create_routes INTEGER NOT NULL DEFAULT 1 CHECK(auto_create_routes IN (0, 1));
