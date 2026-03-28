-- Migration 022: Protocol-ready schema
-- Sprint 0 Foundation — expand constraints, add reserved columns for lifecycle/governance

-- 1. Expand chunks.status CHECK to 6 states (adds 'under_review')
-- (migration 008 named this constraint explicitly: chunks_status_check)
ALTER TABLE chunks DROP CONSTRAINT IF EXISTS chunks_status_check;
ALTER TABLE chunks ADD CONSTRAINT chunks_status_check
  CHECK (status IN ('active', 'proposed', 'disputed', 'retracted', 'superseded', 'under_review'));

-- 2. Expand votes.target_type CHECK to include 'chunk'
-- (inline CHECK from migration 001 has auto-generated name — find dynamically)
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'votes'::regclass AND contype = 'c'
  AND pg_get_constraintdef(oid) LIKE '%target_type%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE votes DROP CONSTRAINT %I', cname);
  END IF;
END $$;
ALTER TABLE votes ADD CONSTRAINT votes_target_type_check
  CHECK (target_type IN ('message', 'policing_action', 'chunk'));

-- 3. Protocol-ready columns on chunks
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT false;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS dispute_count INT DEFAULT 0;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS resubmit_count INT DEFAULT 0;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS confidentiality VARCHAR(10) DEFAULT 'public';
COMMENT ON COLUMN chunks.hidden IS 'RESERVED: not yet enforced — hide chunk from public views';
COMMENT ON COLUMN chunks.dispute_count IS 'Number of times this chunk has been disputed';
COMMENT ON COLUMN chunks.resubmit_count IS 'Number of times this chunk has been resubmitted after retraction';
COMMENT ON COLUMN chunks.confidentiality IS 'RESERVED: not yet enforced — future access control tiers';

-- 4. Protocol-ready columns on accounts
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tier INT DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS interaction_count INT DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS reputation_copyright FLOAT DEFAULT 0.5;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS quarantine_until TIMESTAMPTZ;
COMMENT ON COLUMN accounts.tier IS 'RESERVED: account tier — 0=new, 1=contributor, 2=trusted';
COMMENT ON COLUMN accounts.interaction_count IS 'Total interaction count for tier calculation';
COMMENT ON COLUMN accounts.reputation_copyright IS 'RESERVED: copyright trust score';
COMMENT ON COLUMN accounts.quarantine_until IS 'RESERVED: quarantine enforcement timestamp';
