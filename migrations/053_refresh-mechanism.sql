-- Migration 053: Article Refresh Mechanism
-- Adds topic-level freshness tracking and chunk-level refresh flags.
-- Design: private/REFRESH-DESIGN.md

-- === Topic columns ===

ALTER TABLE topics
  ADD COLUMN to_be_refreshed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN refresh_requested_by UUID NULL REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN refresh_requested_at TIMESTAMPTZ NULL,
  ADD COLUMN refresh_reason TEXT NULL,
  ADD COLUMN last_refreshed_by UUID NULL REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN last_refreshed_at TIMESTAMPTZ NULL,
  ADD COLUMN refresh_check_count INT NOT NULL DEFAULT 0;

CREATE INDEX idx_topics_to_be_refreshed
  ON topics (to_be_refreshed) WHERE to_be_refreshed = TRUE;
CREATE INDEX idx_topics_last_refreshed_at
  ON topics (last_refreshed_at) WHERE last_refreshed_at IS NOT NULL;

-- === chunk_refresh_flags table ===

CREATE TABLE chunk_refresh_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  flagged_by UUID NOT NULL REFERENCES accounts(id),
  flagged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT NOT NULL,
  evidence JSONB NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'addressed', 'dismissed')),
  addressed_in_changeset_id UUID NULL,
  addressed_at TIMESTAMPTZ NULL,
  dismissed_by UUID NULL REFERENCES accounts(id),
  dismissed_at TIMESTAMPTZ NULL,
  dismissed_reason TEXT NULL
);

CREATE INDEX idx_chunk_refresh_flags_chunk_pending
  ON chunk_refresh_flags (chunk_id) WHERE status = 'pending';
CREATE INDEX idx_chunk_refresh_flags_flagged_at
  ON chunk_refresh_flags (flagged_at);

-- === Trigger: auto-set topics.to_be_refreshed on new pending flag ===

CREATE OR REPLACE FUNCTION fn_refresh_flag_set_topic()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    UPDATE topics SET to_be_refreshed = TRUE
    WHERE id IN (
      SELECT topic_id FROM chunk_topics WHERE chunk_id = NEW.chunk_id
    )
    AND to_be_refreshed = FALSE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_refresh_flag_set_topic
  AFTER INSERT ON chunk_refresh_flags
  FOR EACH ROW
  EXECUTE FUNCTION fn_refresh_flag_set_topic();
