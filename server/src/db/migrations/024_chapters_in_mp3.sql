-- Writing an episode's chapters into its MP3 (ID3 tags) runs in the background; its last result.
ALTER TABLE episodes ADD COLUMN id3_status text CHECK (id3_status IN ('running', 'done', 'failed'));
ALTER TABLE episodes ADD COLUMN id3_error text;
ALTER TABLE episodes ADD COLUMN id3_at timestamptz;
