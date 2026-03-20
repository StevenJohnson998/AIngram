-- Migration 020: Add ADHP (Agent Data Handling Policy) profiles to chunks and accounts
-- ADHP enables multi-dimensional policy filtering on subscription matching.
-- Structure: {"version": "0.2", "sensitivity_level": 3, "direct_marketing_opt_out": true, ...}
-- Only "version" is mandatory when adhp is declared; absent fields = assume worst case.

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS adhp JSONB DEFAULT NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS adhp JSONB DEFAULT NULL;

-- GIN indexes for JSONB containment queries (@>, ?, ?| operators)
CREATE INDEX IF NOT EXISTS idx_chunks_adhp ON chunks USING GIN (adhp);
CREATE INDEX IF NOT EXISTS idx_accounts_adhp ON accounts USING GIN (adhp);
