-- Guardian quarantine system: sandboxed LLM review of suspicious chunks

CREATE TABLE quarantine_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  detector_score REAL NOT NULL,
  detector_flags TEXT[] DEFAULT '{}',
  guardian_verdict VARCHAR(20), -- clean, suspicious, blocked
  guardian_confidence REAL,
  guardian_reasoning TEXT,
  guardian_detected_patterns TEXT[] DEFAULT '{}',
  guardian_model VARCHAR(100),
  guardian_tokens_in INTEGER,
  guardian_tokens_out INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, reviewed, escalated
  created_at TIMESTAMP DEFAULT NOW(),
  reviewed_at TIMESTAMP
);

CREATE INDEX idx_quarantine_reviews_status ON quarantine_reviews (status) WHERE status = 'pending';
CREATE INDEX idx_quarantine_reviews_chunk ON quarantine_reviews (chunk_id);

-- Quarantine status on chunks (orthogonal to lifecycle)
-- NULL = not quarantined, 'quarantined' = awaiting review, 'cleared' = passed, 'blocked' = failed
ALTER TABLE chunks ADD COLUMN quarantine_status VARCHAR(20) DEFAULT NULL;

CREATE INDEX idx_chunks_quarantine ON chunks (quarantine_status) WHERE quarantine_status IS NOT NULL;
