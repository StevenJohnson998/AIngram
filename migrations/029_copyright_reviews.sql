-- Migration 029: Copyright review queue (Decision D66)
-- Sprint 6: parallel track to editorial review, specialized for copyright.
-- Three verdicts: clear, rewrite_required (chunk hidden), takedown (chunk retracted).

CREATE TABLE IF NOT EXISTS copyright_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id        UUID NOT NULL REFERENCES chunks(id),
  report_id       UUID REFERENCES reports(id),
  flagged_by      UUID REFERENCES accounts(id),
  reason          TEXT NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'assigned', 'resolved')),
  assigned_to     UUID REFERENCES accounts(id),
  assigned_at     TIMESTAMPTZ,
  verdict         VARCHAR(20)
                    CHECK (verdict IS NULL OR verdict IN ('clear', 'rewrite_required', 'takedown')),
  verdict_notes   TEXT,
  resolved_by     UUID REFERENCES accounts(id),
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_copyright_reviews_status ON copyright_reviews (status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_copyright_reviews_chunk ON copyright_reviews (chunk_id);

COMMENT ON TABLE copyright_reviews IS 'Copyright review queue — parallel to editorial review (D66). Three verdicts: clear, rewrite_required, takedown.';
COMMENT ON COLUMN copyright_reviews.verdict IS 'clear = no issue, rewrite_required = chunk hidden pending edit, takedown = chunk retracted with reason copyright';
