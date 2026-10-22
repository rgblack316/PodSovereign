-- OP3 all-time downloads: read each show's whole OP3 history, not just the last year.
-- History older than the forward sync is read separately ("backfill"), and the whole
-- history is re-read about once a month to pick up OP3's later corrections.
ALTER TABLE podcasts ADD COLUMN op3_backfill_until timestamptz; -- backfill has read up to here
ALTER TABLE podcasts ADD COLUMN op3_backfill_end timestamptz;   -- ...and stops here; NULL = no backfill pending
ALTER TABLE podcasts ADD COLUMN op3_history_at timestamptz;     -- when the whole history was last read

-- Shows already syncing: read their whole history (what's saved stays shown while it's re-read).
UPDATE podcasts SET op3_backfill_until = '2021-01-01T00:00:00Z', op3_backfill_end = date_trunc('day', op3_synced_until AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
 WHERE op3_synced_until IS NOT NULL;
