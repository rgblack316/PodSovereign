-- How Podping is sent: through the Podcast Index hub (no key), podping.cloud (key), or not at all.
-- NULL = automatic: podping.cloud when a key is saved, otherwise the hub.
ALTER TABLE site_settings ADD COLUMN podping_mode text CHECK (podping_mode IN ('auto', 'hub', 'cloud', 'off'));
