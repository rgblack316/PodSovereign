-- Rebuild a show's website (Cloudflare Pages, Netlify, Vercel, Render, GitHub Actions or a
-- custom webhook) when its feed changes. Hook URLs, tokens and header values are secrets,
-- stored encrypted in `secrets`.
CREATE TABLE site_build_hooks (
  podcast_id uuid PRIMARY KEY REFERENCES podcasts(id) ON DELETE CASCADE,
  enabled    boolean NOT NULL DEFAULT false,
  service    text NOT NULL DEFAULT 'cloudflare',
  settings   json NOT NULL DEFAULT '{}',   -- non-secret fields (repo owner/name, event type, method, header names, body)
  secrets    text,                         -- encrypted JSON: {url?, token?, headers?: {name: value}}
  events     text[] NOT NULL DEFAULT '{published,edited,deleted,scheduled}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE site_build_queue (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  podcast_id  uuid NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  events      text[] NOT NULL DEFAULT '{}',  -- what changed (several quick changes collapse into one build)
  trigger     text NOT NULL DEFAULT 'auto' CHECK (trigger IN ('auto', 'manual', 'test')),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  next_try_at timestamptz NOT NULL DEFAULT now(),
  last_status integer,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE UNIQUE INDEX site_build_one_pending ON site_build_queue (podcast_id) WHERE status = 'pending';
CREATE INDEX site_build_due ON site_build_queue (next_try_at) WHERE status = 'pending';
