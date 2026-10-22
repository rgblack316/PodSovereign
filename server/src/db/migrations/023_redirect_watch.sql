-- After a show's old feed is confirmed to redirect here, it's re-checked weekly in the background.
ALTER TABLE podcasts ADD COLUMN redirect_confirmed_at timestamptz; -- first time the redirect checked out
UPDATE podcasts SET redirect_confirmed_at = redirect_checked_at WHERE redirect_status = 'ok';
