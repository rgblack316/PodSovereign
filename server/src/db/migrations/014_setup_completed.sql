-- When a show's setup steps were all done. The dashboard hides the Overview tab 7 days later.
ALTER TABLE podcasts ADD COLUMN setup_completed_at timestamptz;
