-- Link connection tokens to a specific sub-account
ALTER TABLE connection_tokens ADD COLUMN sub_account_id UUID REFERENCES accounts(id);
