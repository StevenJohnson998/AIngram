-- Migration 012: Add reject reason tracking to chunks
-- Stores why a proposed chunk was rejected and by whom

ALTER TABLE chunks ADD COLUMN reject_reason TEXT;
ALTER TABLE chunks ADD COLUMN rejected_by UUID REFERENCES accounts(id);
ALTER TABLE chunks ADD COLUMN rejected_at TIMESTAMPTZ;
