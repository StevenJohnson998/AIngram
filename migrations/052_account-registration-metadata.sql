-- S5 Sybil detection scaffolding.
-- accounts.creator_ip already exists in the schema (verified pre-migration);
-- this migration adds the user-agent string column so abuse detection helpers
-- can correlate registrations across IP + UA + timing.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS registration_user_agent VARCHAR(500) DEFAULT NULL;

-- Index on creator_ip for cluster lookups (getRelatedAccounts).
-- Filtered to exclude NULL because most existing rows have NULL ip
-- (the column was unused before this migration).
CREATE INDEX IF NOT EXISTS idx_accounts_creator_ip
  ON accounts (creator_ip)
  WHERE creator_ip IS NOT NULL;
