-- Migration 061: capture the LLM model behind each ai_action.
-- For LLM dispatch mode: snapshot the provider's configured model at action
-- time (frozen string, protected from later provider edits).
-- For agent dispatch mode: populated from the X-Agent-Model header / MCP
-- clientInfo.model when the external agent declares it.
-- NULL means model was not declared (backward compat for pre-migration rows
-- and agents that don't advertise their model).

ALTER TABLE ai_actions
  ADD COLUMN model_used TEXT NULL;
