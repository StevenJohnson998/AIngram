-- Migration 048: Add embedding column to topics for semantic duplicate detection.
ALTER TABLE topics ADD COLUMN embedding vector(768);
CREATE INDEX idx_topics_embedding ON topics USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
