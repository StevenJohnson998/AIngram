-- Migration 043: Subscription ack tracking + discussion notification support.
-- Adds last_read_at for polling ack pattern.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
