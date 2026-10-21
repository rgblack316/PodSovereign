-- Daily OP3 downloads per country, summed from OP3's download records, so longer ranges
-- (90 days, a year) don't re-download every record on each view.
CREATE TABLE op3_daily (
  podcast_id uuid NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  day        date NOT NULL,          -- UTC day
  country    text NOT NULL DEFAULT '', -- two-letter code; '' = unknown
  downloads  integer NOT NULL,
  PRIMARY KEY (podcast_id, day, country)
);
ALTER TABLE podcasts ADD COLUMN op3_synced_until timestamptz;  -- records before this are summed
ALTER TABLE podcasts ADD COLUMN op3_synced_at timestamptz;     -- when the last sync finished
ALTER TABLE podcasts ADD COLUMN op3_sync_error text;
