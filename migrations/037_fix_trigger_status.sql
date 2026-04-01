-- Migration 037: Fix trigger_status — ensure column exists + correct values
-- Sprint 10A — Migration 018 may have recorded but column may be missing.
-- The rename active→published in Sprint 8 missed this constraint.

-- Ensure column exists (idempotent)
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trigger_status VARCHAR(20) NOT NULL DEFAULT 'published';

-- Drop old constraint if it exists, fix values, add correct constraint
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_trigger_status_check;
UPDATE subscriptions SET trigger_status = 'published' WHERE trigger_status = 'active';
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_trigger_status_check
  CHECK (trigger_status IN ('published', 'proposed', 'both'));
ALTER TABLE subscriptions ALTER COLUMN trigger_status SET DEFAULT 'published';
