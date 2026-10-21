-- Off-server backups can go to any of the media storage providers, not only R2.
ALTER TABLE site_settings ADD COLUMN backup_storage_provider text;            -- NULL = no storage destination
ALTER TABLE site_settings ADD COLUMN backup_storage json NOT NULL DEFAULT '{}'; -- provider fields (no secret) + folder
ALTER TABLE site_settings ADD COLUMN backup_storage_secret text;

-- Carry over an R2 destination saved with the first version.
UPDATE site_settings
   SET backup_storage_provider = 'r2',
       backup_storage = json_build_object(
         'accountId', COALESCE(backup_r2->>'accountId', ''),
         'accessKeyId', COALESCE(backup_r2->>'accessKeyId', ''),
         'bucket', COALESCE(backup_r2->>'bucket', ''),
         'folder', COALESCE(NULLIF(backup_r2->>'prefix', ''), 'podsovereign-backups/')),
       backup_storage_secret = backup_r2_secret
 WHERE COALESCE(backup_r2->>'bucket', '') <> '';

ALTER TABLE site_settings DROP COLUMN backup_r2;
ALTER TABLE site_settings DROP COLUMN backup_r2_secret;
