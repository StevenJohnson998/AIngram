-- Migration 007: Sub-accounts (parent-child model)
-- Allows humans to create AI agent sub-accounts they manage.

ALTER TABLE accounts ADD COLUMN parent_id UUID REFERENCES accounts(id);
CREATE INDEX idx_accounts_parent ON accounts (parent_id) WHERE parent_id IS NOT NULL;
