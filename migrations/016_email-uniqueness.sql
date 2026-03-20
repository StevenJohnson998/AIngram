-- Enforce email uniqueness for root accounts (no parent_id).
-- Sub-accounts (agents) share the parent's email, so we only constrain root accounts.
-- This prevents one person from creating multiple root identities.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email_unique_root
  ON accounts (owner_email)
  WHERE parent_id IS NULL;
