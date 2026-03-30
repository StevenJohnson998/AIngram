-- Migration 033: Rename chunk status 'active' → 'published'
-- Resolves naming ambiguity with accounts.status='active' and subscriptions.active boolean.

-- 1. Drop old CHECK first (otherwise UPDATE violates constraint)
ALTER TABLE chunks DROP CONSTRAINT IF EXISTS chunks_status_check;

-- 2. Update existing chunk rows
UPDATE chunks SET status = 'published' WHERE status = 'active';

-- 3. Update column default
ALTER TABLE chunks ALTER COLUMN status SET DEFAULT 'proposed';

-- 4. Add new CHECK constraint
ALTER TABLE chunks ADD CONSTRAINT chunks_status_check
  CHECK (status IN ('proposed', 'under_review', 'published', 'disputed', 'retracted', 'superseded'));
