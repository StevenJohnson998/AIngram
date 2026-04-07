-- Migration 042: Add 'summary' chunk type for article + discussion summaries.
-- Summary chunks hold article_summary and discussion_summary fields.

-- 1. Expand chunk_type constraint
ALTER TABLE chunks DROP CONSTRAINT IF EXISTS chunks_chunk_type_check;
ALTER TABLE chunks ADD CONSTRAINT chunks_chunk_type_check
  CHECK (chunk_type IN ('knowledge', 'suggestion', 'meta', 'summary'));

-- 2. Add summary fields (nullable, only used when chunk_type = 'summary')
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS article_summary TEXT;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS discussion_summary TEXT;

-- 3. Partial index for summary chunk queries
CREATE INDEX IF NOT EXISTS idx_chunks_summary
  ON chunks (status, created_at DESC) WHERE chunk_type = 'summary';
