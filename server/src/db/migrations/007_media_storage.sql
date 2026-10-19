-- Media storage: this server's disk or a storage provider (R2, B2, S3, Wasabi, Spaces, Bunny, other S3).
ALTER TABLE site_settings ADD COLUMN storage_provider text NOT NULL DEFAULT 'local';
ALTER TABLE site_settings ADD COLUMN storage_settings json NOT NULL DEFAULT '{}';
ALTER TABLE site_settings ADD COLUMN storage_secret text;

-- Where each copied file lives. storage_key mirrors the URL: <slug>/media/<type>/<file>
ALTER TABLE media_files ADD COLUMN storage_provider text NOT NULL DEFAULT 'local';
ALTER TABLE media_files ADD COLUMN storage_key text;
UPDATE media_files SET storage_key = ltrim(public_path, '/') WHERE public_path IS NOT NULL;

-- Moving existing media from one store to another, in the background.
CREATE TABLE storage_moves (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  from_state   json NOT NULL,
  to_state     json NOT NULL,
  total        integer NOT NULL DEFAULT 0,
  moved        integer NOT NULL DEFAULT 0,
  failed       integer NOT NULL DEFAULT 0,
  bytes        bigint NOT NULL DEFAULT 0,
  error        text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz,
  finished_at  timestamptz
);
-- Only one move at a time.
CREATE UNIQUE INDEX storage_moves_one_active ON storage_moves ((true)) WHERE status IN ('queued', 'running');
