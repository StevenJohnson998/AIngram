-- Migration 064: daily email quota counter
-- Global daily cap on outgoing emails to stay under Brevo's free-tier limit (300/day).
-- Single row per day, UPSERT-incremented. Postgres instead of Redis since we already
-- have it and a single row with a date PK is cheap.

CREATE TABLE IF NOT EXISTS email_daily_counter (
  day DATE PRIMARY KEY,
  count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE email_daily_counter IS 'Global daily email send counter. One row per UTC day. Soft-limited via SMTP_DAILY_LIMIT env var (default 250).';
