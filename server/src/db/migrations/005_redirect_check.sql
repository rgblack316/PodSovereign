-- Result of the dashboard's "is the old feed 301-redirecting here?" check.
ALTER TABLE podcasts ADD COLUMN redirect_status text
  CHECK (redirect_status IN ('ok', 'temporary', 'elsewhere', 'none', 'unreachable'));
ALTER TABLE podcasts ADD COLUMN redirect_detail text;
ALTER TABLE podcasts ADD COLUMN redirect_checked_at timestamptz;
