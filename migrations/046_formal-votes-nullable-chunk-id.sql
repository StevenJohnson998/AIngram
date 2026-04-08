-- Migration 046: Make formal_votes.chunk_id nullable.
-- New formal votes use changeset_id instead. Legacy chunk_id kept for backward compat.
ALTER TABLE formal_votes ALTER COLUMN chunk_id DROP NOT NULL;
