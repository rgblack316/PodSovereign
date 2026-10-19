-- Podcast Feed Host — PostgreSQL schema (draft)
-- Approach: typed columns for core/commonly-edited tags, plus a generic
-- tag_elements table so EVERY iTunes / Podcasting 2.0 tag (including new or
-- unknown ones) round-trips without schema changes.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ───────────── Accounts & access ─────────────
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext UNIQUE NOT NULL,
  password_hash  text NOT NULL,                   -- argon2id
  display_name   text,
  is_admin       boolean NOT NULL DEFAULT false,  -- server admin only, not podcast access
  totp_secret    text,                            -- optional 2FA
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          text PRIMARY KEY,                   -- random token, stored hashed
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Podcasts (channel) ─────────────
CREATE TABLE podcasts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  slug             text UNIQUE NOT NULL,          -- /feed/{slug}/feed.xml and /{slug}/media/...
  source_feed_url  text,                          -- original feed imported from
  imported_at      timestamptz,

  -- RSS core
  title            text NOT NULL,
  description      text,
  link             text,
  language         text,
  copyright        text,
  image_url        text,

  -- iTunes
  itunes_author    text,
  itunes_type      text CHECK (itunes_type IN ('episodic','serial')),
  itunes_explicit  boolean NOT NULL DEFAULT false,
  itunes_owner_name  text,
  itunes_owner_email text,
  itunes_categories  jsonb,                       -- [{"text":"Arts","sub":["Books"]}]
  itunes_block     boolean NOT NULL DEFAULT false,
  itunes_complete  boolean NOT NULL DEFAULT false,
  itunes_new_feed_url text,

  -- Podcasting 2.0 (single-value tags)
  podcast_guid     uuid,                          -- preserve on import!
  podcast_locked   boolean NOT NULL DEFAULT false,
  podcast_locked_owner text,
  podcast_medium   text,

  -- Feed output
  feed_cache_xml   text,                          -- regenerated on change
  feed_cache_etag  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON podcasts (owner_id);

-- Optional co-hosts / editors
CREATE TABLE podcast_members (
  podcast_id  uuid REFERENCES podcasts(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('editor','viewer')),
  PRIMARY KEY (podcast_id, user_id)
);

-- ───────────── Episodes (item) ─────────────
CREATE TABLE episodes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  podcast_id       uuid NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  guid             text NOT NULL,                 -- preserve original
  guid_is_permalink boolean,                      -- NULL = attribute absent in source
  status           text NOT NULL DEFAULT 'published'
                   CHECK (status IN ('draft','scheduled','published')),
  pub_date         timestamptz,

  title            text NOT NULL,
  description      text,                          -- HTML allowed (CDATA on output)
  link             text,

  -- Enclosure (stored WITHOUT stats prefixes; prefixes applied at render)
  enclosure_media_id uuid,                        -- FK added below
  enclosure_url    text,                          -- public URL on this server
  enclosure_length bigint,
  enclosure_type   text,

  -- iTunes
  itunes_title     text,
  itunes_duration  integer,                       -- seconds
  itunes_episode   integer,
  itunes_season    integer,
  itunes_episode_type text CHECK (itunes_episode_type IN ('full','trailer','bonus')),
  itunes_explicit  boolean,
  itunes_image_url text,
  itunes_block     boolean NOT NULL DEFAULT false,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (podcast_id, guid)
);
CREATE INDEX ON episodes (podcast_id, pub_date DESC);

-- ───────────── Generic tag store (all other / repeatable tags) ─────────────
-- Holds podcast:person, transcript, chapters, soundbite, value, funding,
-- location, season, episode, license, alternateEnclosure, liveItem, txt,
-- podroll, remoteItem, socialInteract, chat, trailer, images, updateFrequency,
-- plus any unknown namespaced element — nested children kept as JSON.
CREATE TABLE tag_elements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  podcast_id  uuid NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  episode_id  uuid REFERENCES episodes(id) ON DELETE CASCADE, -- NULL = channel level
  ns_uri      text NOT NULL,      -- e.g. https://podcastindex.org/namespace/1.0
  ns_prefix   text NOT NULL,      -- e.g. podcast
  name        text NOT NULL,      -- e.g. person
  attributes  jsonb NOT NULL DEFAULT '{}',
  value       text,
  children    jsonb,              -- nested elements, e.g. value > valueRecipient
  media_id    uuid,               -- if it references a hosted file (transcript, chapters)
  sort_order  integer NOT NULL DEFAULT 0
);
CREATE INDEX ON tag_elements (podcast_id, episode_id, sort_order);

-- ───────────── Hosted media ─────────────
CREATE TABLE media_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  podcast_id   uuid NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('audio','video','image','transcript','chapters','other')),
  original_url text,              -- where it came from on import
  storage_path text NOT NULL,     -- /var/lib/feedhost/media/{slug}/{type}/{file}
  public_path  text NOT NULL,     -- /{slug}/media/{type}/{file}
  mime_type    text,
  bytes        bigint,
  sha256       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE episodes ADD FOREIGN KEY (enclosure_media_id) REFERENCES media_files(id);
ALTER TABLE tag_elements ADD FOREIGN KEY (media_id) REFERENCES media_files(id);

-- ───────────── Stats prefixes ─────────────
-- Built-in catalog (seeded). {param} placeholder is filled per podcast.
CREATE TABLE prefix_services (
  key          text PRIMARY KEY,
  name         text NOT NULL,
  template     text NOT NULL,     -- prefix template
  param_label  text,              -- e.g. 'Show ID' when template contains {param}
  help_url     text,
  sort_hint    integer NOT NULL DEFAULT 100
);

INSERT INTO prefix_services (key, name, template, param_label, help_url, sort_hint) VALUES
 ('op3',      'OP3',          'https://op3.dev/e/',                   NULL,          'https://op3.dev',            10),
 ('podtrac',  'Podtrac',      'https://dts.podtrac.com/redirect.mp3/',NULL,          'https://analytics.podtrac.com', 20),
 ('podscribe','Podscribe',    'https://pscrb.fm/rss/p/',              NULL,          'https://podscribe.com',      30),
 ('magellan', 'Magellan AI',  'https://mgln.ai/e/{param}/',           'Account ID',  'https://magellan.ai',        40),
 ('blubrry',  'Blubrry Stats','https://media.blubrry.com/{param}/',   'Show keyword','https://blubrry.com',        50),
 ('custom',   'Custom prefix','{param}',                              'Full prefix URL', NULL,                     90);

-- Per-podcast checkbox state + order in the chain
CREATE TABLE podcast_prefixes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  podcast_id   uuid NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  service_key  text NOT NULL REFERENCES prefix_services(key),
  enabled      boolean NOT NULL DEFAULT false,   -- the checkbox
  param_value  text,                             -- ID/slug where required
  position     integer NOT NULL DEFAULT 0,       -- 0 = outermost
  prefix_alternate_enclosures boolean NOT NULL DEFAULT false
);
-- One row per built-in service; several custom prefixes allowed.
CREATE UNIQUE INDEX podcast_prefixes_one_per_service
  ON podcast_prefixes (podcast_id, service_key) WHERE service_key <> 'custom';

-- ───────────── Audit / import log ─────────────
CREATE TABLE import_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  podcast_id  uuid REFERENCES podcasts(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id),
  source_url  text NOT NULL,
  status      text NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','done','failed')),
  progress    jsonb,                             -- {"episodes":120,"media_done":45}
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
