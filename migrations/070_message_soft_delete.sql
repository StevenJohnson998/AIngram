-- Migration 070: Soft delete support for messages (retract / hide)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS retracted_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS retracted_by UUID REFERENCES accounts(id);
