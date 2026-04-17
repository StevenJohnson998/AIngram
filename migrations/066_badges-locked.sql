-- Migration 066: Allow manual badge overrides to survive reputation recalc
-- When badges_locked = true, recalculateBadges skips this account.

ALTER TABLE accounts ADD COLUMN badges_locked BOOLEAN NOT NULL DEFAULT false;
