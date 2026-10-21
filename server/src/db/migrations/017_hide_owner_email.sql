-- Leave the owner email out of the public feed (itunes:owner and the podcast:locked owner).
ALTER TABLE podcasts ADD COLUMN hide_owner_email boolean NOT NULL DEFAULT false;
