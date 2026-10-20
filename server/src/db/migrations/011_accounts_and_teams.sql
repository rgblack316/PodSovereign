-- Deleting accounts: a deleted user's import history goes with them.
ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_user_id_fkey;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS podcast_members_user ON podcast_members (user_id);
