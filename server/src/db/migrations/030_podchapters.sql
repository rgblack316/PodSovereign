-- PodChapters: AI chapters made on request from the episode's transcript.
-- The account's API key (encrypted) is a site setting; the style options are per show.
ALTER TABLE site_settings ADD COLUMN podchapters_key text;

ALTER TABLE podcasts
  ADD COLUMN podchapters_style text NOT NULL DEFAULT 'balance' CHECK (podchapters_style IN ('strict', 'balance', 'creative')),
  ADD COLUMN podchapters_count text NOT NULL DEFAULT 'moderate' CHECK (podchapters_count IN ('fewer', 'moderate', 'more')),
  ADD COLUMN podchapters_ads boolean NOT NULL DEFAULT false,
  ADD COLUMN podchapters_links boolean NOT NULL DEFAULT false;

-- The PodChapters copy of an episode, kept so a second run reuses it instead of adding another.
CREATE TABLE podchapters_episodes (
  episode_id  uuid PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  pc_id       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
