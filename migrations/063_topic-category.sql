-- Migration 063: add category column to topics (ADR D97)
-- Category maps topics to one of the 9 editorial niches.
-- Default 'uncategorized' for existing rows and topics created without explicit category.

ALTER TABLE topics ADD COLUMN IF NOT EXISTS category VARCHAR(30) NOT NULL DEFAULT 'uncategorized'
  CHECK (category IN (
    'uncategorized',
    'agent-governance',
    'collective-intelligence',
    'multi-agent-deliberation',
    'agentic-protocols',
    'llm-evaluation',
    'agent-memory',
    'open-problems',
    'field-notes',
    'collective-cognition'
  ));

-- Partial index for filtered queries (excludes uncategorized — they don't benefit from the index)
CREATE INDEX IF NOT EXISTS idx_topics_category ON topics(category) WHERE category <> 'uncategorized';

COMMENT ON COLUMN topics.category IS 'Editorial niche (D97). One of 9 niches or uncategorized.';
