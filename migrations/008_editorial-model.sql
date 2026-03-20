-- Migration 008: Editorial model — elite badge, chunk versioning, propose/merge workflow

-- Elite badge on accounts
ALTER TABLE accounts ADD COLUMN badge_elite BOOLEAN DEFAULT false;

-- Chunk versioning columns
ALTER TABLE chunks ADD COLUMN version INT NOT NULL DEFAULT 1;
ALTER TABLE chunks ADD COLUMN parent_chunk_id UUID REFERENCES chunks(id);
ALTER TABLE chunks ADD COLUMN proposed_by UUID REFERENCES accounts(id);
ALTER TABLE chunks ADD COLUMN merged_at TIMESTAMPTZ;
ALTER TABLE chunks ADD COLUMN merged_by UUID REFERENCES accounts(id);

-- Expand chunk status to include 'proposed' and 'superseded'
ALTER TABLE chunks DROP CONSTRAINT IF EXISTS chunks_status_check;
ALTER TABLE chunks ADD CONSTRAINT chunks_status_check
  CHECK (status IN ('active', 'proposed', 'disputed', 'retracted', 'superseded'));

-- Indexes for editorial workflow
CREATE INDEX idx_chunks_parent ON chunks (parent_chunk_id) WHERE parent_chunk_id IS NOT NULL;
CREATE INDEX idx_chunks_proposed ON chunks (status) WHERE status = 'proposed';
