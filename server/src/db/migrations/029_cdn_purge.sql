-- Made files keep their exact names and are replaced in place, so names no longer need reserving.
DROP TABLE IF EXISTS used_media_names;

-- Clearing replaced files from Cloudflare's cache.
ALTER TABLE site_settings
  ADD COLUMN cf_zone_id text,
  ADD COLUMN cf_api_token text,
  ADD COLUMN cf_purge_at timestamptz,
  ADD COLUMN cf_purge_error text;
