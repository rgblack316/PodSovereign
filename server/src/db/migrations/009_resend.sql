-- Email can go through SMTP or the Resend API. smtp_from is the "From" address for both.
ALTER TABLE site_settings ADD COLUMN mail_provider text NOT NULL DEFAULT 'smtp' CHECK (mail_provider IN ('smtp', 'resend'));
ALTER TABLE site_settings ADD COLUMN resend_api_key text;
