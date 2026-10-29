-- Every media address ever handed out for a made file (processed audio, MP3s with chapters, transcripts),
-- so a name like "ru053.mp3" is never reused for different content after the old file is cleaned up:
-- CDNs and podcast apps may still have the old one cached under that address.
CREATE TABLE used_media_names (
  public_path text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO used_media_names (public_path) SELECT public_path FROM media_files ON CONFLICT DO NOTHING;
