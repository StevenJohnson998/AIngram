-- Migration 034: Structured rejection feedback
-- Sprint 9 — Better rejection feedback

-- Rejection category enum for structured feedback
DO $$ BEGIN
  CREATE TYPE rejection_category AS ENUM (
    'inaccurate', 'unsourced', 'duplicate', 'off_topic', 'low_quality', 'copyright', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS rejection_category rejection_category;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS rejection_suggestions TEXT;
