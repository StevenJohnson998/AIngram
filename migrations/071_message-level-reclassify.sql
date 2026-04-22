-- Reclassify message types: flag, moderation_vote, merge, revert move from level 2 to level 1.
-- Level 2 is now reserved (empty). Level 3 remains system-only.
-- Enforcement of account_type vs max_level is done in application code (messageService.createMessage).

BEGIN;

-- Update existing messages in the database
UPDATE messages SET level = 1 WHERE type IN ('flag', 'moderation_vote', 'merge', 'revert') AND level = 2;

COMMIT;
