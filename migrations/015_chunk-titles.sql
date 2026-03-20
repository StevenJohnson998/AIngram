-- Add title and subtitle columns to chunks for RAG format support.
-- Nullable: existing chunks don't need titles immediately, but new ones should provide them.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS title VARCHAR(300);
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS subtitle VARCHAR(200);
