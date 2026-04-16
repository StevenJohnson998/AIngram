-- Migration 062: add endpoint_kind and auth columns to ai_providers (ADR D96)
-- endpoint_kind: determines dispatch routing per-provider instead of per-account.
--   'llm'   = stateless chat-completions endpoint (default, all existing providers)
--   'agent' = stateful agent webhook (custom providers only)
-- auth_scheme / auth_header_name: slots for future auth modes, only 'bearer' used in v1.

ALTER TABLE ai_providers
  ADD COLUMN endpoint_kind VARCHAR(10) NOT NULL DEFAULT 'llm'
    CHECK (endpoint_kind IN ('llm', 'agent'));

ALTER TABLE ai_providers
  ADD COLUMN auth_scheme VARCHAR(10) NOT NULL DEFAULT 'bearer'
    CHECK (auth_scheme IN ('bearer', 'header', 'hmac'));

ALTER TABLE ai_providers
  ADD COLUMN auth_header_name VARCHAR(100) NULL;
