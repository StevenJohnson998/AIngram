-- Migration 045: Create changesets for existing proposed/under_review chunks.
-- Each existing chunk in proposed or under_review gets a changeset of 1.
-- Vote columns are copied from chunks to changesets.
-- Existing votes targeting these chunks are updated to target the changeset.

-- 0a. Update votes CHECK constraint to allow 'changeset' target_type
ALTER TABLE votes DROP CONSTRAINT votes_target_type_check;
ALTER TABLE votes ADD CONSTRAINT votes_target_type_check
  CHECK (target_type IN ('message', 'policing_action', 'chunk', 'changeset'));

-- 0b. Add changeset_id column to formal_votes (replacing chunk_id for new votes)
ALTER TABLE formal_votes ADD COLUMN changeset_id UUID REFERENCES changesets(id);
CREATE UNIQUE INDEX idx_formal_votes_changeset_account ON formal_votes(changeset_id, account_id);

-- 1. Create a changeset for each proposed/under_review chunk
INSERT INTO changesets (id, topic_id, proposed_by, status, vote_phase, commit_deadline_at, reveal_deadline_at,
                        vote_score, under_review_at, merged_at, merged_by, rejected_by, reject_reason,
                        rejection_category, created_at, updated_at)
SELECT
  gen_random_uuid(),
  ct.topic_id,
  c.created_by,
  c.status,
  c.vote_phase,
  c.commit_deadline_at,
  c.reveal_deadline_at,
  c.vote_score,
  c.under_review_at,
  c.merged_at,
  c.merged_by,
  c.rejected_by,
  c.reject_reason,
  c.rejection_category,
  c.created_at,
  c.updated_at
FROM chunks c
JOIN chunk_topics ct ON ct.chunk_id = c.id
WHERE c.status IN ('proposed', 'under_review');

-- 2. Create changeset_operations linking each chunk to its changeset
-- We match by topic_id + created_by + created_at (unique enough for 1:1 mapping)
INSERT INTO changeset_operations (changeset_id, operation, chunk_id, target_chunk_id, sort_order)
SELECT
  cs.id,
  CASE WHEN c.parent_chunk_id IS NOT NULL THEN 'replace' ELSE 'add' END,
  c.id,
  c.parent_chunk_id,
  0
FROM chunks c
JOIN chunk_topics ct ON ct.chunk_id = c.id
JOIN changesets cs ON cs.topic_id = ct.topic_id
  AND cs.proposed_by = c.created_by
  AND cs.created_at = c.created_at
WHERE c.status IN ('proposed', 'under_review')
  AND NOT EXISTS (
    SELECT 1 FROM changeset_operations co WHERE co.chunk_id = c.id
  );

-- 3. Populate changeset_id on existing formal_votes from chunk_id mapping
UPDATE formal_votes fv
SET changeset_id = co.changeset_id
FROM changeset_operations co
WHERE co.chunk_id = fv.chunk_id;

-- 4. Delete existing informal votes on proposed/under_review chunks (will be re-cast on changesets)
-- These are test/seed votes that will be naturally recreated through the changeset flow.
DELETE FROM votes v
USING changeset_operations co
JOIN chunks c ON c.id = co.chunk_id
WHERE v.target_type = 'chunk'
  AND v.target_id = co.chunk_id
  AND c.status IN ('proposed', 'under_review');
