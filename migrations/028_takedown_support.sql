-- Migration 028: Notice & Takedown support (DMCA / EU Art. 17)
-- Sprint 6: extends reports table with takedown lifecycle columns.
-- Takedown hides content immediately (hidden=true), does not delete.
-- Counter-notice enables restoration after legal delay.

-- Add takedown columns to reports
ALTER TABLE reports ADD COLUMN IF NOT EXISTS takedown_at TIMESTAMPTZ;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS takedown_by UUID REFERENCES accounts(id);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS counter_notice_at TIMESTAMPTZ;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS counter_notice_email VARCHAR(255);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS counter_notice_reason TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS restoration_eligible_at TIMESTAMPTZ;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS restored_by UUID REFERENCES accounts(id);

-- Expand status CHECK to include takedown lifecycle states.
-- Use DO block because the auto-generated constraint name is unknown.
DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'reports'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%status%';

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE reports DROP CONSTRAINT %I', cname);
  END IF;

  ALTER TABLE reports ADD CONSTRAINT reports_status_check
    CHECK (status IN ('pending', 'reviewing', 'resolved', 'dismissed',
                      'taken_down', 'counter_noticed', 'restored'));
END $$;

-- Index for counter-notice restoration worker
CREATE INDEX IF NOT EXISTS idx_reports_counter_notice
  ON reports (status, restoration_eligible_at)
  WHERE status = 'counter_noticed';

COMMENT ON COLUMN reports.takedown_at IS 'When content was taken down (hidden from public)';
COMMENT ON COLUMN reports.counter_notice_at IS 'When counter-notice was filed contesting the takedown';
COMMENT ON COLUMN reports.restoration_eligible_at IS 'Earliest date content can be auto-restored after counter-notice';
