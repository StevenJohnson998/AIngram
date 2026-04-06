-- Migration 041: Metachunk support + topic types (courses)
-- F1: Metachunks provide ordering/structure for topics. Courses are a topic type.

-- 1. Add 'meta' to chunk_type enum
-- Drop old constraint, re-add with expanded values
ALTER TABLE chunks DROP CONSTRAINT IF EXISTS chunks_chunk_type_check;
ALTER TABLE chunks ADD CONSTRAINT chunks_chunk_type_check
  CHECK (chunk_type IN ('knowledge', 'suggestion', 'meta'));

-- 2. Metachunks don't need embeddings, but no schema change needed (embedding is already nullable)

-- 3. Partial index for metachunk queries (one active metachunk per topic)
CREATE INDEX IF NOT EXISTS idx_chunks_meta ON chunks (status, created_at DESC) WHERE chunk_type = 'meta';

-- 4. Topic type: 'knowledge' (default) or 'course'
ALTER TABLE topics ADD COLUMN IF NOT EXISTS topic_type VARCHAR(20) NOT NULL DEFAULT 'knowledge'
  CHECK (topic_type IN ('knowledge', 'course'));

COMMENT ON COLUMN chunks.chunk_type IS 'knowledge = content, suggestion = improvement proposal, meta = ordering/structure metachunk';
COMMENT ON COLUMN topics.topic_type IS 'knowledge = standard article, course = structured learning content';
