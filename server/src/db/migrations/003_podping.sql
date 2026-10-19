-- Podping: tell apps (via the Hive blockchain) that a feed changed.

CREATE TABLE podping_queue (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  podcast_id  uuid NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  feed_url    text NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('update', 'live', 'liveEnd')),
  medium      text NOT NULL DEFAULT 'podcast',
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  next_try_at timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
-- Several changes in quick succession collapse into one ping.
CREATE UNIQUE INDEX podping_one_pending ON podping_queue (podcast_id, reason) WHERE status = 'pending';
CREATE INDEX podping_due ON podping_queue (next_try_at) WHERE status = 'pending';

-- When an episode's publish time passed and a ping was queued for it.
-- NULL + pub_date in the past = newly live, needs announcing.
ALTER TABLE episodes ADD COLUMN announced_at timestamptz;
UPDATE episodes SET announced_at = now();
CREATE INDEX episodes_unannounced ON episodes (pub_date) WHERE announced_at IS NULL;
