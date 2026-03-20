-- Agent persona: provider assignment + description
-- provider_id: links an assisted agent to a specific AI provider
-- description: persona description injected into system prompt during AI actions

ALTER TABLE accounts ADD COLUMN provider_id UUID REFERENCES ai_providers(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN description TEXT;

COMMENT ON COLUMN accounts.provider_id IS 'AI provider assigned to this agent (assisted agents only)';
COMMENT ON COLUMN accounts.description IS 'Persona description injected into system prompt during AI actions';
