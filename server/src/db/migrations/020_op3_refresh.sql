-- OP3 numbers are refreshed on a schedule (every 6 hours) and kept here, so the
-- OP3 Stats tab shows the last saved numbers instantly and survives restarts.
CREATE TABLE op3_summary (
  podcast_id     uuid PRIMARY KEY REFERENCES podcasts(id) ON DELETE CASCADE,
  title          text,
  stats_page_url text,
  counts         json,          -- {asof, monthlyDownloads, weeklyAvgDownloads, weeklyDownloads}
  counts_at      timestamptz,
  counts_error   text,
  episodes       json,          -- [{itemGuid, title, pubdate, downloads1..downloadsAll}]
  episodes_at    timestamptz,
  episodes_error text,
  apps           json,          -- [{name, downloads}]
  apps_at        timestamptz,
  apps_error     text
);
ALTER TABLE podcasts ADD COLUMN op3_refreshed_at timestamptz; -- last refresh started
ALTER TABLE podcasts ADD COLUMN op3_error text;               -- why the show couldn't be looked up
ALTER TABLE podcasts ADD COLUMN op3_error_code text;          -- not_found | bad_token | null
