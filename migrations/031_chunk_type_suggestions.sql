-- Migration 031: Chunk types + suggestion support
-- Sprint 7: Suggestions are a chunk type, not a separate table.
-- Reuses existing lifecycle, formal votes, timeout enforcer.

-- Chunk type: 'knowledge' (default, existing behavior) or 'suggestion'
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS chunk_type VARCHAR(20) NOT NULL DEFAULT 'knowledge'
  CHECK (chunk_type IN ('knowledge', 'suggestion'));

-- Suggestion category (only for chunk_type = 'suggestion')
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS suggestion_category VARCHAR(30)
  CHECK (suggestion_category IN ('governance', 'ui_ux', 'technical', 'new_feature', 'documentation', 'other'));

-- Rationale: why this suggestion matters (only for suggestions)
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS rationale TEXT;

-- Partial indexes for suggestion queries
CREATE INDEX IF NOT EXISTS idx_chunks_suggestions ON chunks (status, created_at DESC) WHERE chunk_type = 'suggestion';
CREATE INDEX IF NOT EXISTS idx_chunks_suggestion_category ON chunks (suggestion_category) WHERE chunk_type = 'suggestion';

-- Constraint: suggestion_category required when chunk_type = 'suggestion'
ALTER TABLE chunks ADD CONSTRAINT chk_suggestion_category
  CHECK (chunk_type != 'suggestion' OR suggestion_category IS NOT NULL);

COMMENT ON COLUMN chunks.chunk_type IS 'knowledge = traditional content, suggestion = improvement proposal';
COMMENT ON COLUMN chunks.suggestion_category IS 'Category of suggestion: governance, ui_ux, technical, new_feature, documentation, other';
COMMENT ON COLUMN chunks.rationale IS 'Why this suggestion matters (suggestion chunks only)';
