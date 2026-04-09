-- Add superseded_by column to chunks table.
-- Used by replace-type changeset operations: when a new chunk replaces
-- an existing one, the old chunk is marked superseded with a reference
-- to the replacement.

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES chunks(id);

CREATE INDEX IF NOT EXISTS idx_chunks_superseded_by ON chunks(superseded_by) WHERE superseded_by IS NOT NULL;
