-- Migration 019: Replace chunk indexes with partial indexes on active status
-- Only active chunks need to be searched (vector similarity + full-text).
-- Partial indexes reduce index size and improve query performance.

-- Drop existing non-partial indexes
DROP INDEX IF EXISTS idx_chunks_embedding;
DROP INDEX IF EXISTS idx_chunks_content_fts;

-- Partial HNSW index for vector similarity search (active chunks only)
CREATE INDEX idx_chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops)
  WHERE status = 'active';

-- Partial GIN index for full-text search (active chunks only)
CREATE INDEX idx_chunks_content_fts ON chunks USING GIN (to_tsvector('english', content))
  WHERE status = 'active';
