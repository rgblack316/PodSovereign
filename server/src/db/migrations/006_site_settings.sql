-- Site settings edited by admins in the dashboard. One row. NULL = use the environment default.
CREATE TABLE site_settings (
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
  site_name          text,
  public_base_url    text,
  media_base_url     text,
  allow_registration boolean,
  podping_token      text,
  logo_file          text,
  logo_type          text,
  favicon_file       text,
  favicon_type       text,
  -- Hostnames used before a base-URL change; their feed/media requests are 301-redirected.
  previous_hosts     text[] NOT NULL DEFAULT '{}',
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO site_settings (id) VALUES (true);
