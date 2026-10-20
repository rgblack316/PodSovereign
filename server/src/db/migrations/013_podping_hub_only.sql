-- Podping always goes through the Podcast Index hub (no key). The podping.cloud key,
-- the method setting and the per-ping medium are no longer used.
ALTER TABLE site_settings DROP COLUMN IF EXISTS podping_token;
ALTER TABLE site_settings DROP COLUMN IF EXISTS podping_mode;
ALTER TABLE podping_queue DROP COLUMN IF EXISTS medium;
