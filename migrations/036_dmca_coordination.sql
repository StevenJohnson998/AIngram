-- Migration 036: DMCA coordination detection support
-- Sprint 9 — Coordinated DMCA detection

ALTER TABLE copyright_reviews ADD COLUMN IF NOT EXISTS coordination_flag BOOLEAN DEFAULT false;
ALTER TABLE copyright_reviews ADD COLUMN IF NOT EXISTS coordination_details JSONB;

-- Partial index for coordination queries
CREATE INDEX IF NOT EXISTS idx_copyright_reviews_coordination
  ON copyright_reviews (coordination_flag) WHERE coordination_flag = true;
