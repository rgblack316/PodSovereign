-- Ownership verification on import, and outgoing email (SMTP) for verification codes.

ALTER TABLE site_settings ADD COLUMN require_verification boolean NOT NULL DEFAULT true;
ALTER TABLE site_settings ADD COLUMN smtp_host text;
ALTER TABLE site_settings ADD COLUMN smtp_port integer;
ALTER TABLE site_settings ADD COLUMN smtp_security text CHECK (smtp_security IN ('tls', 'starttls', 'none'));
ALTER TABLE site_settings ADD COLUMN smtp_user text;
ALTER TABLE site_settings ADD COLUMN smtp_password text;
ALTER TABLE site_settings ADD COLUMN smtp_from text;

-- A new job status: the feed was read, and the importer must prove ownership before anything is saved.
ALTER TABLE import_jobs DROP CONSTRAINT import_jobs_status_check;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_status_check
  CHECK (status IN ('queued', 'running', 'verifying', 'done', 'failed'));

ALTER TABLE import_jobs ADD COLUMN preview json;                 -- title, art, episode count, owner email (masked)
ALTER TABLE import_jobs ADD COLUMN verify_token text;            -- goes in <podcast:txt purpose="verify"> or the description
ALTER TABLE import_jobs ADD COLUMN verify_email text;            -- the feed's owner email (codes are sent here)
ALTER TABLE import_jobs ADD COLUMN verify_code_hash text;        -- sha256 of the emailed code, never the code
ALTER TABLE import_jobs ADD COLUMN verify_code_expires timestamptz;
ALTER TABLE import_jobs ADD COLUMN verify_sends integer NOT NULL DEFAULT 0;
ALTER TABLE import_jobs ADD COLUMN verify_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE import_jobs ADD COLUMN verified_at timestamptz;
ALTER TABLE import_jobs ADD COLUMN verified_method text CHECK (verified_method IN ('feed', 'email', 'admin', 'not_required'));
