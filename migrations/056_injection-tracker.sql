-- Migration 056: Injection score tracker + security config
-- Cumulative injection score with time decay, blocking, and review.

-- 1. Security config table (tunable parameters, not in source code)
CREATE TABLE IF NOT EXISTS security_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- PLACEHOLDER seed values — deliberately stricter than any tuned
-- production setting. Real thresholds live in the gitignored
-- `src/config/security-defaults.json` or are set at runtime via
-- `UPDATE security_config`. Committing tuned values here would let an
-- attacker read the block thresholds from the public repo. On first
-- install the seed provisions a defensive default; operators must then
-- tune (lax or strict) via the JSON file or the DB table.
INSERT INTO security_config (key, value) VALUES
  ('injection_half_life_ms', '3600000'),
  ('injection_block_threshold', '0.5'),
  ('injection_min_score_logged', '0.05'),
  ('security_example_weight', '0.1')
ON CONFLICT (key) DO NOTHING;

-- 2. Per-account cumulative injection score
CREATE TABLE IF NOT EXISTS injection_scores (
  account_id UUID PRIMARY KEY REFERENCES accounts(id),
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_at TIMESTAMPTZ,
  review_status VARCHAR(15) DEFAULT NULL
    CHECK (review_status IN ('pending', 'clean', 'confirmed'))
);

-- 3. Injection detection log (every detection, even sub-threshold)
CREATE TABLE IF NOT EXISTS injection_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  score DOUBLE PRECISION NOT NULL,
  cumulative_score DOUBLE PRECISION NOT NULL,
  content_preview TEXT,
  field_type TEXT,
  flags TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_injection_log_account
  ON injection_log (account_id, created_at DESC);

-- 4. Add 'injection_auto' to flags.detection_type constraint
ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_detection_type_check;
ALTER TABLE flags ADD CONSTRAINT flags_detection_type_check
  CHECK (detection_type IN (
    'manual', 'temporal_burst', 'network_cluster',
    'creator_cluster', 'topic_concentration', 'injection_auto'
  ));
