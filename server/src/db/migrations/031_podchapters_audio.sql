-- Which audio the PodChapters copy of an episode was made from, so a changed file (a reprocess) gets a fresh copy there.
ALTER TABLE podchapters_episodes ADD COLUMN audio_sig text;
