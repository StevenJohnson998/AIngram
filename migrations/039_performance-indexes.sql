-- Performance indexes for scaling beyond MVP data volumes.
-- These support temporal queries on votes, subscription matching, and activity feeds.

CREATE INDEX IF NOT EXISTS idx_votes_account_time
  ON votes (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chunk_topics_composite
  ON chunk_topics (topic_id, chunk_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_active
  ON subscriptions (account_id, active, created_at DESC) WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_activity_log_account
  ON activity_log (account_id, action, created_at DESC);
