-- Backups: download from the admin panel, or on a schedule by email and/or to an R2 bucket.
ALTER TABLE site_settings ADD COLUMN backup_frequency text NOT NULL DEFAULT 'off' CHECK (backup_frequency IN ('off', 'daily', 'weekly'));
ALTER TABLE site_settings ADD COLUMN backup_hour integer NOT NULL DEFAULT 3 CHECK (backup_hour BETWEEN 0 AND 23);
ALTER TABLE site_settings ADD COLUMN backup_weekday integer NOT NULL DEFAULT 0 CHECK (backup_weekday BETWEEN 0 AND 6); -- 0 = Sunday
ALTER TABLE site_settings ADD COLUMN backup_timezone text NOT NULL DEFAULT 'UTC';
ALTER TABLE site_settings ADD COLUMN backup_email boolean NOT NULL DEFAULT false;
ALTER TABLE site_settings ADD COLUMN backup_email_to text;              -- NULL = every administrator
ALTER TABLE site_settings ADD COLUMN backup_r2 json NOT NULL DEFAULT '{}'; -- {accountId, accessKeyId, bucket, prefix}
ALTER TABLE site_settings ADD COLUMN backup_r2_secret text;
ALTER TABLE site_settings ADD COLUMN backup_keep integer NOT NULL DEFAULT 14 CHECK (backup_keep BETWEEN 1 AND 365);
ALTER TABLE site_settings ADD COLUMN backup_passphrase text;
ALTER TABLE site_settings ADD COLUMN backup_next_at timestamptz;

CREATE TABLE backup_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger     text NOT NULL CHECK (trigger IN ('download', 'manual', 'scheduled')),
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  file_name   text,
  bytes       bigint,
  encrypted   boolean NOT NULL DEFAULT false,
  results     json NOT NULL DEFAULT '[]',   -- [{to: 'email'|'r2', ok, detail}]
  error       text,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX backup_runs_recent ON backup_runs (created_at DESC);
