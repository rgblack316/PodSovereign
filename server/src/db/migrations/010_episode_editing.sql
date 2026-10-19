-- Publishing from the dashboard: new shows, new and edited episodes, and file uploads.

-- Uploads arrive in chunks (Cloudflare Tunnel limits a single request to 100 MB),
-- so a half-finished upload can be resumed.
CREATE TABLE uploads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  podcast_id  uuid NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  kind        text NOT NULL CHECK (kind IN ('audio','video','image','transcript','chapters','other')),
  filename    text NOT NULL,                 -- cleaned-up original name
  mime_type   text NOT NULL,
  size        bigint NOT NULL,
  received    bigint NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  media_id    uuid REFERENCES media_files(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uploads_stale ON uploads (updated_at);

-- What we learned about an uploaded file.
ALTER TABLE media_files ADD COLUMN duration integer;      -- seconds, audio and video
ALTER TABLE media_files ADD COLUMN width integer;         -- images
ALTER TABLE media_files ADD COLUMN height integer;
ALTER TABLE media_files ADD COLUMN original_name text;    -- the uploaded file's name
