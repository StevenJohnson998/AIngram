-- Migration 021: Add terms acceptance tracking to accounts
-- Stores which version of the Terms was accepted and when.
-- terms_version_accepted is NULL for accounts created before this migration.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terms_version_accepted VARCHAR(30);
