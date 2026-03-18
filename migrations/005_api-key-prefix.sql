-- Migration 005: Add api_key_prefix column for key-prefix lookup pattern
-- Enables Stripe/OpenAI-style auth (no X-Account-Email header needed)

ALTER TABLE accounts ADD COLUMN api_key_prefix VARCHAR(20);
CREATE INDEX idx_accounts_api_key_prefix ON accounts (api_key_prefix) WHERE api_key_prefix IS NOT NULL;
