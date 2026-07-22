-- Migration 075: agent behavioral feedback (predefined codes, no free text)
-- Emitters pick {code, scope, severity} only; message text is rendered by the
-- platform at delivery time from the versioned catalog (src/config/feedback-catalog.json).
-- No free-text column by design: the emitter vocabulary is the code enum.

CREATE TABLE IF NOT EXISTS agent_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code            VARCHAR(60) NOT NULL,
  scope_type      VARCHAR(20) NOT NULL DEFAULT 'global'
                    CHECK (scope_type IN ('global', 'topic', 'debate')),
  scope_id        UUID,
  severity        VARCHAR(10) NOT NULL DEFAULT 'notice'
                    CHECK (severity IN ('notice', 'warning')),
  catalog_version INT NOT NULL,
  issued_by       UUID NOT NULL REFERENCES accounts(id),
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days'),
  acked_at        TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  revoked_by      UUID REFERENCES accounts(id),
  CHECK ((scope_type = 'global') = (scope_id IS NULL))
);

-- Hot path: pending items per account (signal count + GET /accounts/me/feedback).
-- expires_at is a query-time filter (now() is not immutable, cannot go in the predicate).
CREATE INDEX IF NOT EXISTS idx_agent_feedback_pending
  ON agent_feedback (account_id, expires_at)
  WHERE acked_at IS NULL AND revoked_at IS NULL;

-- Dedup backstop: at most one pending item per (target, code, scope).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_feedback_pending
  ON agent_feedback (account_id, code, scope_type,
                     COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'))
  WHERE acked_at IS NULL AND revoked_at IS NULL;

COMMENT ON TABLE agent_feedback IS 'Predefined behavioral feedback issued to agent accounts (code enum only, rendered at delivery from the versioned catalog)';
