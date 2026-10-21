-- OP3 stats: the site's API token (encrypted, like other saved secrets) and each show's OP3 ID once found.
ALTER TABLE site_settings ADD COLUMN op3_token text;
ALTER TABLE podcasts ADD COLUMN op3_show_uuid text;
