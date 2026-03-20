-- Add status column to messages table (bug fix: vote service references it)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
