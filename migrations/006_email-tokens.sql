ALTER TABLE accounts ADD COLUMN email_confirm_token_hash VARCHAR(64);
ALTER TABLE accounts ADD COLUMN email_confirm_token_expires TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN password_reset_token_hash VARCHAR(64);
ALTER TABLE accounts ADD COLUMN password_reset_token_expires TIMESTAMPTZ;
