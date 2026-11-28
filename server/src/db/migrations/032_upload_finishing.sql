-- Finishing a big upload (checking it and copying it to storage) can take longer than
-- Cloudflare's 100 seconds, so it now runs in the background and the page polls.
ALTER TABLE uploads DROP CONSTRAINT IF EXISTS uploads_status_check;
ALTER TABLE uploads ADD CONSTRAINT uploads_status_check CHECK (status IN ('open', 'finishing', 'done', 'failed'));
ALTER TABLE uploads ADD COLUMN error text;
