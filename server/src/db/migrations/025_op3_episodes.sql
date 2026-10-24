-- Per-episode OP3 downloads, summed from OP3's download records (OP3's own per-episode
-- query only covers a show's most recent episodes).
CREATE TABLE op3_episodes (
  podcast_id     uuid NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  op3_episode_id text NOT NULL,          -- OP3's episode id (64 hex characters)
  url            text,                   -- an address it was downloaded from (matches it to our episode)
  title          text,                   -- from OP3's list of the show's episodes
  pubdate        timestamptz,
  episode_id     uuid REFERENCES episodes(id) ON DELETE SET NULL, -- our episode, once matched
  PRIMARY KEY (podcast_id, op3_episode_id)
);
CREATE TABLE op3_episode_hours (
  podcast_id     uuid NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  op3_episode_id text NOT NULL,
  hour           timestamptz NOT NULL,   -- UTC hour
  downloads      integer NOT NULL,
  PRIMARY KEY (podcast_id, op3_episode_id, hour)
);

-- Shows already syncing: re-read their whole history so every episode gets counted.
UPDATE podcasts SET op3_backfill_until = '2021-01-01T00:00:00Z', op3_backfill_end = date_trunc('day', op3_synced_until AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
 WHERE op3_synced_until IS NOT NULL;
