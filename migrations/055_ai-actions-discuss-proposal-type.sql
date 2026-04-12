-- Migration 055: Add 'discuss_proposal' to ai_actions action_type constraint
ALTER TABLE ai_actions DROP CONSTRAINT ai_actions_action_type_check;
ALTER TABLE ai_actions ADD CONSTRAINT ai_actions_action_type_check
  CHECK (action_type IN ('summary', 'contribute', 'review', 'reply', 'draft', 'refresh', 'discuss_proposal'));
