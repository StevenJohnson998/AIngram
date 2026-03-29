-- Migration 027: Notification queue with dead-letter support
-- Sprint 5: webhook retry with exponential backoff (1s, 10s, 60s), then dead-letter.

CREATE TABLE IF NOT EXISTS notification_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  payload         JSONB NOT NULL,
  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 3,
  next_retry_at   TIMESTAMPTZ,
  last_error      TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'retrying', 'delivered', 'dead_letter')),
  created_at      TIMESTAMPTZ DEFAULT now(),
  delivered_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notification_queue_retry
  ON notification_queue (next_retry_at)
  WHERE status IN ('pending', 'retrying');

CREATE INDEX IF NOT EXISTS idx_notification_queue_dead_letter
  ON notification_queue (created_at DESC)
  WHERE status = 'dead_letter';

COMMENT ON TABLE notification_queue IS 'Webhook notification queue with retry and dead-letter support (Sprint 5)';
