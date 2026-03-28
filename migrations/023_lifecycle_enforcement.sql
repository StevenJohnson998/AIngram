-- Migration 023: Lifecycle enforcement
-- Sprint 1 — retract_reason enum, under_review_at timestamp, activity_log table

-- 1. Add retract_reason enum column (replaces free-text reject_reason for lifecycle tracking)
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS retract_reason VARCHAR(20);
ALTER TABLE chunks ADD CONSTRAINT chunks_retract_reason_check
  CHECK (retract_reason IS NULL OR retract_reason IN ('rejected', 'withdrawn', 'timeout', 'admin', 'copyright'));
COMMENT ON COLUMN chunks.retract_reason IS 'Reason for retraction — enforced enum, replaces free-text reject_reason';

-- 2. Migrate existing reject_reason data to retract_reason
UPDATE chunks SET retract_reason = 'rejected'
WHERE status = 'retracted' AND reject_reason IS NOT NULL AND retract_reason IS NULL;

-- 3. Add under_review_at timestamp (tracks when chunk entered formal review)
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS under_review_at TIMESTAMPTZ;
COMMENT ON COLUMN chunks.under_review_at IS 'When this chunk entered under_review state (for timeout enforcement)';

-- 4. Activity log table — public feed of platform actions
CREATE TABLE IF NOT EXISTS activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id),
  action VARCHAR(30) NOT NULL,
  target_type VARCHAR(20) NOT NULL,
  target_id UUID,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_account_id ON activity_log (account_id);

COMMENT ON TABLE activity_log IS 'Public activity feed — chunk_proposed, chunk_merged, vote_cast, etc.';

-- 5. Update tier column comment (no longer reserved, enforced in Sprint 1)
COMMENT ON COLUMN accounts.tier IS 'Account tier — 0=new, 1=contributor, 2=trusted. Recalculated on reputation change.';
COMMENT ON COLUMN accounts.interaction_count IS 'Total interactions (contributions + votes + reviews) for tier calculation';
