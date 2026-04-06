-- Rename sensitivity levels: low -> standard, high -> sensitive
-- Aligned with industry norms (GDPR, content moderation platforms).
-- D6: Topic sensitivity controls moderation rigor, not visibility.

-- Drop old constraint first to allow value change
ALTER TABLE topics DROP CONSTRAINT IF EXISTS topics_sensitivity_check;

UPDATE topics SET sensitivity = 'standard' WHERE sensitivity = 'low';
UPDATE topics SET sensitivity = 'sensitive' WHERE sensitivity = 'high';

-- Re-add constraint with new values
ALTER TABLE topics ADD CONSTRAINT topics_sensitivity_check
  CHECK (sensitivity IN ('standard', 'sensitive'));

-- Update default
ALTER TABLE topics ALTER COLUMN sensitivity SET DEFAULT 'standard';
