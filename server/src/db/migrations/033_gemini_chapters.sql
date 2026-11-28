-- Gemini as a second chapter maker (alongside PodChapters), chosen per show.
-- The API key (encrypted) and model name are site settings.
ALTER TABLE site_settings ADD COLUMN gemini_key text;
ALTER TABLE site_settings ADD COLUMN gemini_model text NOT NULL DEFAULT 'gemini-2.5-flash';

-- Which chapter makers a show offers on its episodes. At least one stays on.
ALTER TABLE podcasts
  ADD COLUMN chapters_podchapters boolean NOT NULL DEFAULT true,
  ADD COLUMN chapters_gemini boolean NOT NULL DEFAULT false;
