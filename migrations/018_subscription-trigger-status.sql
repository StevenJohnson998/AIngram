-- Migration 018: Add trigger_status to subscriptions
-- Allows subscriptions to trigger on 'active', 'proposed', or 'both' chunk statuses

ALTER TABLE subscriptions
  ADD COLUMN trigger_status VARCHAR(20) NOT NULL DEFAULT 'active';

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_trigger_status_check
  CHECK (trigger_status IN ('active', 'proposed', 'both'));
