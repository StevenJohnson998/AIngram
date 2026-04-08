-- Migration 044: Changeset tables for batched multi-operation proposals.
-- Changesets group one or more chunk operations (add, replace, remove)
-- into a single reviewable/votable unit tied to a topic.

CREATE TABLE changesets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id            UUID NOT NULL REFERENCES topics(id),
  proposed_by         UUID NOT NULL REFERENCES accounts(id),
  description         TEXT,
  status              TEXT NOT NULL DEFAULT 'proposed',
  vote_phase          TEXT,
  commit_deadline_at  TIMESTAMPTZ,
  reveal_deadline_at  TIMESTAMPTZ,
  vote_score          NUMERIC,
  under_review_at     TIMESTAMPTZ,
  merged_at           TIMESTAMPTZ,
  merged_by           UUID REFERENCES accounts(id),
  rejected_by         UUID REFERENCES accounts(id),
  reject_reason       TEXT,
  rejection_category  TEXT,
  retract_reason      TEXT,
  initial_trust_score NUMERIC,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_changesets_topic ON changesets(topic_id);
CREATE INDEX idx_changesets_status ON changesets(status);
CREATE INDEX idx_changesets_proposed_by ON changesets(proposed_by);

CREATE TABLE changeset_operations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  changeset_id      UUID NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
  operation         TEXT NOT NULL,
  chunk_id          UUID REFERENCES chunks(id),
  target_chunk_id   UUID REFERENCES chunks(id),
  sort_order        INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_changeset_ops_changeset ON changeset_operations(changeset_id);
