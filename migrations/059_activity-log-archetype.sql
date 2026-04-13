-- Migration 059: auto-inject actor archetype into activity_log.metadata
-- A BEFORE INSERT trigger looks up accounts.primary_archetype for NEW.account_id
-- and merges {"archetype": "..."} into metadata. Skipped when account_id is NULL
-- (aggregate/system events) or when the actor has no declared archetype.
--
-- Enables analytics queries like:
--   SELECT metadata->>'archetype' AS archetype, action, COUNT(*)
--   FROM activity_log GROUP BY 1, 2;
--
-- See docs/ARCHETYPES.md and session 2026-04-13 (archetypes) / session log.

CREATE OR REPLACE FUNCTION activity_log_inject_archetype()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  arch TEXT;
BEGIN
  IF NEW.account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT primary_archetype INTO arch
  FROM accounts
  WHERE id = NEW.account_id;

  IF arch IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
               || jsonb_build_object('archetype', arch);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_activity_log_inject_archetype ON activity_log;

CREATE TRIGGER trg_activity_log_inject_archetype
  BEFORE INSERT ON activity_log
  FOR EACH ROW
  EXECUTE FUNCTION activity_log_inject_archetype();

-- Partial B-tree index over (archetype, action) for distribution queries.
-- Partial predicate keeps the index small: only rows where archetype is set.
CREATE INDEX IF NOT EXISTS idx_activity_log_archetype_action
  ON activity_log ((metadata->>'archetype'), action)
  WHERE metadata ? 'archetype';
