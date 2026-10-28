-- Auphonic's automatic chapters and show notes (one Auphonic feature, chosen per show and per episode).
ALTER TABLE podcasts
  ADD COLUMN auphonic_chapters text NOT NULL DEFAULT 'ours' CHECK (auphonic_chapters IN ('ours', 'auphonic')),
  ADD COLUMN auphonic_shownotes boolean NOT NULL DEFAULT false;

ALTER TABLE auphonic_jobs
  ADD COLUMN options jsonb,      -- { chapters: 'ours' | 'auphonic', shownotes: boolean }
  ADD COLUMN shownotes jsonb,    -- what Auphonic wrote: { long, brief, subtitle, tags }
  ADD COLUMN shownotes_applied boolean NOT NULL DEFAULT false;
