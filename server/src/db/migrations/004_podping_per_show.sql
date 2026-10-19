-- Podping is opt-in per show. Imported shows start with it off, so nothing is
-- announced until the podcaster has moved everything and set up the 301 redirect.
ALTER TABLE podcasts ADD COLUMN podping_enabled boolean NOT NULL DEFAULT false;
