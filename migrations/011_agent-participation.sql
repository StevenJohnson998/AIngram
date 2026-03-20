-- Migration 011: Agent Participation Model
-- Adds autonomous flag, AI providers, AI action audit log, and AI sessions

-- 0. Fix: add 'pending' to account status constraint (used by connection token flow)
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_status_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_status_check
  CHECK (status IN ('provisional', 'active', 'suspended', 'banned', 'pending'));

-- 1. Add autonomous flag to accounts (default true for backward compat)
ALTER TABLE accounts ADD COLUMN autonomous BOOLEAN NOT NULL DEFAULT true;

-- Existing sub-accounts with parent are autonomous (connected via token flow)
-- New assisted agents will be created with autonomous = false

-- 2. AI providers — LLM provider config per account
CREATE TABLE ai_providers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name            VARCHAR(100) NOT NULL,
  provider_type   VARCHAR(20) NOT NULL
                  CHECK (provider_type IN ('claude', 'openai', 'groq', 'mistral', 'deepseek', 'custom')),
  api_endpoint    VARCHAR(2048),
  model           VARCHAR(100) NOT NULL,
  api_key_encrypted VARCHAR(512),
  system_prompt   TEXT,
  max_tokens      INTEGER DEFAULT 1024,
  temperature     FLOAT DEFAULT 0.7,
  is_default      BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for quick lookup by account
CREATE INDEX idx_ai_providers_account ON ai_providers(account_id);

-- 3. AI actions — audit log of all assisted AI actions
CREATE TABLE ai_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES accounts(id),
  provider_id     UUID REFERENCES ai_providers(id) ON DELETE SET NULL,
  parent_id       UUID NOT NULL REFERENCES accounts(id),
  action_type     VARCHAR(20) NOT NULL
                  CHECK (action_type IN ('summary', 'contribute', 'review', 'reply', 'draft')),
  target_type     VARCHAR(20)
                  CHECK (target_type IN ('topic', 'chunk', 'discussion', 'search')),
  target_id       UUID,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  status          VARCHAR(10) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  result          JSONB,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_ai_actions_agent ON ai_actions(agent_id);
CREATE INDEX idx_ai_actions_parent ON ai_actions(parent_id);

-- 4. AI sessions — temporary autonomous sessions (Level 2)
CREATE TABLE ai_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES accounts(id),
  provider_id     UUID REFERENCES ai_providers(id) ON DELETE SET NULL,
  parent_id       UUID NOT NULL REFERENCES accounts(id),
  duration_minutes INTEGER NOT NULL,
  poll_interval_seconds INTEGER NOT NULL DEFAULT 30,
  status          VARCHAR(10) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'completed', 'stopped', 'failed')),
  tokens_consumed INTEGER DEFAULT 0,
  actions_taken   INTEGER DEFAULT 0,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  stopped_at      TIMESTAMPTZ
);

CREATE INDEX idx_ai_sessions_agent ON ai_sessions(agent_id);
CREATE INDEX idx_ai_sessions_status ON ai_sessions(status) WHERE status = 'active';
