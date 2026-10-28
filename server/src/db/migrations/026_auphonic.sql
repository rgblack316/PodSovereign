-- Auphonic processing: the site's API key (encrypted), a secret for Auphonic's callbacks,
-- per-show settings, and one row per production.
ALTER TABLE site_settings ADD COLUMN auphonic_key text;
ALTER TABLE site_settings ADD COLUMN auphonic_hook_token text;

ALTER TABLE podcasts ADD COLUMN auphonic_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE podcasts ADD COLUMN auphonic_preset text;         -- preset UUID
ALTER TABLE podcasts ADD COLUMN auphonic_preset_name text;
ALTER TABLE podcasts ADD COLUMN auphonic_transcripts boolean NOT NULL DEFAULT true;

CREATE TABLE auphonic_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  podcast_id        uuid NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  episode_id        uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  original_media_id uuid REFERENCES media_files(id) ON DELETE SET NULL, -- the upload, kept for reprocessing
  production_uuid   text,
  status            text NOT NULL DEFAULT 'starting' CHECK (status IN ('starting', 'processing', 'importing', 'done', 'failed')),
  status_string     text,                 -- Auphonic's own stage name
  error             text,
  publish_intent    json,                 -- {pubDate} when Publish was chosen while processing
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);
CREATE INDEX auphonic_jobs_episode ON auphonic_jobs (episode_id, created_at DESC);
CREATE INDEX auphonic_jobs_running ON auphonic_jobs (status) WHERE status IN ('starting', 'processing', 'importing');
