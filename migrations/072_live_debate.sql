-- Migration 072: Live Debate feature
-- Adds 'debate' topic type with time-bounded scheduling.

-- Add 'debate' to topic_type CHECK constraint
ALTER TABLE topics DROP CONSTRAINT IF EXISTS topics_topic_type_check;
ALTER TABLE topics ADD CONSTRAINT topics_topic_type_check
  CHECK (topic_type IN ('knowledge', 'course', 'debate'));

-- Debate scheduling columns (nullable — only required for debate type)
ALTER TABLE topics ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;
ALTER TABLE topics ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;

-- Debate topics must have valid schedule
ALTER TABLE topics ADD CONSTRAINT debate_requires_schedule
  CHECK (topic_type != 'debate' OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at));

-- Index for querying active/upcoming debates efficiently
CREATE INDEX IF NOT EXISTS idx_topics_debate_schedule
  ON topics (starts_at, ends_at)
  WHERE topic_type = 'debate';
