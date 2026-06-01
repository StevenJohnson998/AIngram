-- Migration 074: Fix stale partial-index predicates on chunks
--
-- Migration 019 created the chunk search indexes with `WHERE status = 'active'`.
-- Migration 033 renamed all chunk statuses from 'active' to 'published' but did
-- NOT recreate these partial indexes, so their predicate has matched ZERO rows
-- ever since: the HNSW vector index and the GIN full-text index are dead, and
-- every search falls back to a sequential scan (services/vector-search.js and
-- routes/search.js both filter on status = 'published').
--
-- This migration recreates both indexes with the correct 'published' predicate,
-- restoring migration 019's original intent.
--
-- NOTE: the GIN index is on `to_tsvector('english', content)`, but the live
-- search queries compute a different expression (unaccent + multi-field +
-- per-language config). Fixing the predicate here makes the index live again
-- but it will only be used once the index expression is aligned with the query
-- expression. Tracked separately — see LAUNCH-REVIEW-2026-06-01.md (arch-fts-expr).

DROP INDEX IF EXISTS idx_chunks_embedding;
DROP INDEX IF EXISTS idx_chunks_content_fts;

-- Partial HNSW index for vector similarity search (published chunks only)
CREATE INDEX idx_chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops)
  WHERE status = 'published';

-- Partial GIN index for full-text search (published chunks only)
CREATE INDEX idx_chunks_content_fts ON chunks USING GIN (to_tsvector('english', content))
  WHERE status = 'published';
