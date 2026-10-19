-- Import worker + auth additions

-- Feed fidelity
ALTER TABLE podcasts ADD COLUMN extra_namespaces jsonb NOT NULL DEFAULT '{}';
ALTER TABLE podcasts ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('importing','active'));
ALTER TABLE episodes ADD COLUMN sort_index integer NOT NULL DEFAULT 0;   -- source order
-- NULL = tag absent in source (so it isn't invented on export)
ALTER TABLE podcasts ALTER COLUMN podcast_locked DROP NOT NULL;
ALTER TABLE podcasts ALTER COLUMN podcast_locked DROP DEFAULT;
-- Feeds in the wild sometimes carry non-UUID values here; keep them verbatim.
ALTER TABLE podcasts ALTER COLUMN podcast_guid TYPE text;
ALTER TABLE tag_elements ADD COLUMN cdata boolean NOT NULL DEFAULT false;
-- json (not jsonb) keeps XML attribute order exactly as imported.
ALTER TABLE tag_elements ALTER COLUMN attributes DROP DEFAULT;
ALTER TABLE tag_elements ALTER COLUMN attributes TYPE json USING attributes::json;
ALTER TABLE tag_elements ALTER COLUMN attributes SET DEFAULT '{}';
ALTER TABLE tag_elements ALTER COLUMN children TYPE json USING children::json;
CREATE UNIQUE INDEX podcasts_owner_guid ON podcasts (owner_id, podcast_guid) WHERE podcast_guid IS NOT NULL;

-- Media copy tracking (resumable)
ALTER TABLE media_files ADD COLUMN status text NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending','done','failed'));
ALTER TABLE media_files ADD COLUMN error text;
ALTER TABLE media_files ALTER COLUMN storage_path DROP NOT NULL;
ALTER TABLE media_files ALTER COLUMN public_path DROP NOT NULL;
CREATE UNIQUE INDEX media_files_podcast_original ON media_files (podcast_id, original_url);

-- Job queue
ALTER TABLE import_jobs ADD COLUMN options jsonb NOT NULL DEFAULT '{}';
ALTER TABLE import_jobs ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]';
ALTER TABLE import_jobs ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE import_jobs ADD COLUMN started_at timestamptz;
ALTER TABLE import_jobs ADD COLUMN finished_at timestamptz;
ALTER TABLE import_jobs ADD COLUMN heartbeat_at timestamptz;
CREATE INDEX import_jobs_queue ON import_jobs (status, created_at);
CREATE INDEX import_jobs_user ON import_jobs (user_id, created_at DESC);

-- Sessions: id column holds sha256(token), never the token itself
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN user_agent text;
CREATE INDEX sessions_user ON sessions (user_id);
