-- Migration 054: Add 'refresh' to ai_actions action_type constraint
ALTER TABLE ai_actions DROP CONSTRAINT ai_actions_action_type_check;
ALTER TABLE ai_actions ADD CONSTRAINT ai_actions_action_type_check
  CHECK (action_type IN ('summary', 'contribute', 'review', 'reply', 'draft', 'refresh'));
