-- Migration 030: Copyright enforcement improvements
-- Sprint 6: review-first flow, priority escalation, reporter suspension.

-- Priority column on copyright_reviews (high = volume anomaly detected)
ALTER TABLE copyright_reviews ADD COLUMN IF NOT EXISTS priority VARCHAR(10) DEFAULT 'normal'
  CHECK (priority IN ('normal', 'high'));

-- Reporter suspension tracking
-- Tracks accounts suspended from filing copyright reports (DSA Art. 23).
CREATE TABLE IF NOT EXISTS reporter_suspensions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID REFERENCES accounts(id),
  reporter_email  VARCHAR(255),
  reason          TEXT NOT NULL,
  false_positive_rate FLOAT,
  total_reports   INT,
  suspended_until TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reporter_suspensions_account
  ON reporter_suspensions (account_id, suspended_until DESC);
CREATE INDEX IF NOT EXISTS idx_reporter_suspensions_email
  ON reporter_suspensions (reporter_email, suspended_until DESC);

COMMENT ON TABLE reporter_suspensions IS 'DSA Art. 23 — suspension of reporters who frequently submit manifestly unfounded notices';
COMMENT ON COLUMN reporter_suspensions.false_positive_rate IS 'Rate of clear verdicts over total resolved reports at time of suspension';
