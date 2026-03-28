-- Migration 025: Formal voting with commit-reveal protocol
-- Sprint 3: implements formal weighted voting for chunks under review.
-- Separate table from informal votes (different semantics, numeric values, two-phase commit).

-- Formal votes table: commit-reveal protocol for chunk governance
CREATE TABLE formal_votes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id      UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL REFERENCES accounts(id),

  -- Commit phase: voter submits hash(vote_value || reason_tag || salt)
  commit_hash   VARCHAR(128) NOT NULL,
  committed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Reveal phase: populated when voter reveals their vote
  vote_value    SMALLINT CHECK (vote_value IN (-1, 0, 1)),
  reason_tag    VARCHAR(20),
  salt          VARCHAR(64),
  revealed_at   TIMESTAMPTZ,

  -- Weight computed at commit time, clamped to [W_MIN, W_MAX]
  weight        FLOAT NOT NULL,

  UNIQUE(chunk_id, account_id)
);

CREATE INDEX idx_formal_votes_chunk ON formal_votes (chunk_id);
CREATE INDEX idx_formal_votes_unrevealed ON formal_votes (chunk_id) WHERE revealed_at IS NULL;

COMMENT ON TABLE formal_votes IS 'Commit-reveal formal votes for chunk governance (Sprint 3)';

-- Voting phase tracking on chunks (sub-state within under_review)
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS vote_phase VARCHAR(20)
  CHECK (vote_phase IN ('commit', 'reveal', 'resolved'));
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS commit_deadline_at TIMESTAMPTZ;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS reveal_deadline_at TIMESTAMPTZ;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS vote_score FLOAT;

COMMENT ON COLUMN chunks.vote_phase IS 'NULL = no formal vote; commit = accepting hashed votes; reveal = accepting reveals; resolved = tallied';
COMMENT ON COLUMN chunks.commit_deadline_at IS 'End of commit phase';
COMMENT ON COLUMN chunks.reveal_deadline_at IS 'End of reveal phase';
COMMENT ON COLUMN chunks.vote_score IS 'V(c) = weighted vote score after resolution';

-- Index for timeout enforcer: find chunks with active vote phases past deadline
CREATE INDEX IF NOT EXISTS idx_chunks_vote_commit ON chunks (commit_deadline_at)
  WHERE vote_phase = 'commit';
CREATE INDEX IF NOT EXISTS idx_chunks_vote_reveal ON chunks (reveal_deadline_at)
  WHERE vote_phase = 'reveal';
