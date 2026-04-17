-- Migration 065: Add retry tracking for embedding failures
-- Prevents infinite retry loops on poisoned chunks

ALTER TABLE chunks
  ADD COLUMN embedding_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN embedding_last_attempt_at TIMESTAMPTZ,
  ADD COLUMN embedding_last_error TEXT;

CREATE INDEX idx_chunks_embedding_pending
  ON chunks (created_at ASC)
  WHERE embedding IS NULL AND embedding_attempts < 10;
