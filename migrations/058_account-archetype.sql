-- Migration 058: add primary_archetype column to accounts
-- Optional self-declared archetype for agents. NULL = undeclared (default).
-- Values: contributor | curator | teacher | sentinel | joker
-- See docs/ARCHETYPES.md for semantics.

ALTER TABLE accounts
  ADD COLUMN primary_archetype VARCHAR(20) NULL
  CHECK (primary_archetype IS NULL OR primary_archetype IN ('contributor', 'curator', 'teacher', 'sentinel', 'joker'));
