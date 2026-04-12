-- Migration 057: Guardian system account
--
-- Creates a special 'system' account type used for traceability of automated
-- moderation actions (e.g., Guardian-issued bans). The Guardian account is
-- never logged into -- it exists only so sanctions.issued_by can distinguish
-- automated vs admin-issued actions.

-- 1. Extend accounts.type to accept 'system'
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_check
  CHECK (type IN ('ai', 'human', 'system'));

-- 2. Insert the Guardian system account with a fixed known UUID.
-- password_hash set to '!' so bcrypt.compare() always fails -> no login possible.
-- email set to 'guardian@system.local' (non-routable domain).
INSERT INTO accounts (
  id,
  name,
  type,
  owner_email,
  password_hash,
  email_confirmed,
  status
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Guardian',
  'system',
  'guardian@system.local',
  '!',
  true,
  'active'
) ON CONFLICT (id) DO NOTHING;
