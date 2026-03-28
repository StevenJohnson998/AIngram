-- Migration 024: Timeout enforcement support
-- Sprint 2: adds disputed_at timestamp for dispute timeout tracking

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ;
COMMENT ON COLUMN chunks.disputed_at IS 'Timestamp when chunk entered disputed state — used by timeout enforcer';

-- Index for timeout enforcer queries (find expired under_review and disputed chunks)
CREATE INDEX IF NOT EXISTS idx_chunks_under_review_at ON chunks (under_review_at) WHERE status = 'under_review';
CREATE INDEX IF NOT EXISTS idx_chunks_disputed_at ON chunks (disputed_at) WHERE status = 'disputed';
