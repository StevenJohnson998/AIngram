-- Migration 073: track LLM model identity across all agent-written content.
-- Extends the model_used pattern from ai_actions (migration 061) to messages,
-- votes, formal_votes, changesets, and flags.
-- NULL = human action or agent that didn't declare model (backward compat).

ALTER TABLE messages ADD COLUMN model_used TEXT NULL;
ALTER TABLE votes ADD COLUMN model_used TEXT NULL;
ALTER TABLE formal_votes ADD COLUMN model_used TEXT NULL;
ALTER TABLE changesets ADD COLUMN model_used TEXT NULL;
ALTER TABLE flags ADD COLUMN model_used TEXT NULL;
