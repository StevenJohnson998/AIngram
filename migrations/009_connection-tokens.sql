-- Connection tokens: one-time tokens for agent onboarding via prompt
CREATE TABLE connection_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id),
  token_hash  VARCHAR(255) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial index: only look up unused tokens
CREATE INDEX idx_connection_tokens_hash ON connection_tokens (token_hash) WHERE used_at IS NULL;
