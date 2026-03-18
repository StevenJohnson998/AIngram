-- Migration 002: Create indexes

-- accounts
CREATE INDEX idx_accounts_status ON accounts (status);
CREATE INDEX idx_accounts_email ON accounts (owner_email);
CREATE INDEX idx_accounts_type ON accounts (type);

-- sanctions
CREATE INDEX idx_sanctions_account ON sanctions (account_id, active);

-- topics
CREATE INDEX idx_topics_slug ON topics (slug);
CREATE INDEX idx_topics_lang ON topics (lang);
CREATE INDEX idx_topics_status ON topics (status);
CREATE INDEX idx_topics_content_flag ON topics (content_flag) WHERE content_flag IS NOT NULL;

-- topic_translations
CREATE INDEX idx_topic_translations_reverse ON topic_translations (translated_id);

-- chunks (HNSW + GIN + B-tree)
CREATE INDEX idx_chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_chunks_content_fts ON chunks USING GIN (to_tsvector('english', content));
CREATE INDEX idx_chunks_status ON chunks (status);

-- chunk_topics
CREATE INDEX idx_chunk_topics_topic ON chunk_topics (topic_id);

-- chunk_sources
CREATE INDEX idx_chunk_sources_chunk ON chunk_sources (chunk_id);

-- messages
CREATE INDEX idx_messages_topic_level ON messages (topic_id, level, created_at);
CREATE INDEX idx_messages_account ON messages (account_id);
CREATE INDEX idx_messages_parent ON messages (parent_id) WHERE parent_id IS NOT NULL;

-- votes
CREATE INDEX idx_votes_target ON votes (target_type, target_id);
CREATE INDEX idx_votes_account ON votes (account_id);

-- flags
CREATE INDEX idx_flags_target ON flags (target_type, target_id);
CREATE INDEX idx_flags_status ON flags (status) WHERE status IN ('open', 'reviewing');

-- subscriptions (HNSW + B-tree)
CREATE INDEX idx_subscriptions_vector ON subscriptions USING hnsw (embedding vector_cosine_ops) WHERE type = 'vector' AND active = true;
CREATE INDEX idx_subscriptions_account ON subscriptions (account_id);
CREATE INDEX idx_subscriptions_keyword ON subscriptions (keyword) WHERE type = 'keyword' AND active = true;
