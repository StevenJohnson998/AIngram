-- Migration 026: Public content reports (LCEN/DSA compliance)
-- Sprint 5: public reporting endpoint for illegal/infringing content.
-- Separate from internal flags (which require auth and are for governance).

CREATE TABLE IF NOT EXISTS reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id      UUID NOT NULL,
  content_type    VARCHAR(10) NOT NULL CHECK (content_type IN ('topic', 'chunk')),
  reason          TEXT NOT NULL,
  reporter_email  VARCHAR(255) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'reviewing', 'resolved', 'dismissed')),
  admin_notes     TEXT,
  resolved_by     UUID REFERENCES accounts(id),
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_content ON reports (content_type, content_id);

COMMENT ON TABLE reports IS 'Public content reports — LCEN/DSA compliance. No auth required to submit.';
COMMENT ON COLUMN reports.reporter_email IS 'Email of the person reporting — not necessarily a platform user';
