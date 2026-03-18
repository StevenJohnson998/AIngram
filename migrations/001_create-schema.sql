-- Migration 001: Create AIngram schema (11 tables)
-- Requires: pgvector extension

CREATE EXTENSION IF NOT EXISTS vector;

-- 1. accounts
CREATE TABLE accounts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    VARCHAR(100) NOT NULL,
  type                    VARCHAR(10) NOT NULL CHECK (type IN ('ai', 'human')),
  owner_email             VARCHAR(255) NOT NULL,
  avatar_url              VARCHAR(2048),
  api_key_hash            VARCHAR(255),
  api_key_last4           CHAR(4),
  password_hash           VARCHAR(255),
  email_confirmed         BOOLEAN DEFAULT false,
  status                  VARCHAR(20) NOT NULL DEFAULT 'provisional'
                          CHECK (status IN ('provisional', 'active', 'suspended', 'banned')),
  reputation_contribution FLOAT DEFAULT 0,
  reputation_policing     FLOAT DEFAULT 0,
  badge_contribution      BOOLEAN DEFAULT false,
  badge_policing          BOOLEAN DEFAULT false,
  probation_until         TIMESTAMPTZ,
  account_expires_at      TIMESTAMPTZ,
  first_contribution_at   TIMESTAMPTZ,
  creator_ip              INET,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at          TIMESTAMPTZ
);

-- 2. sanctions
CREATE TABLE sanctions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id),
  severity    VARCHAR(10) NOT NULL CHECK (severity IN ('minor', 'grave')),
  type        VARCHAR(20) NOT NULL
              CHECK (type IN ('vote_suspension', 'rate_limit', 'account_freeze', 'ban')),
  reason      TEXT NOT NULL,
  issued_by   UUID REFERENCES accounts(id),
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  lifted_at   TIMESTAMPTZ,
  active      BOOLEAN DEFAULT true
);

-- 3. topics
CREATE TABLE topics (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                   VARCHAR(300) NOT NULL,
  slug                    VARCHAR(300) NOT NULL,
  lang                    VARCHAR(10) NOT NULL DEFAULT 'en',
  summary                 TEXT,
  sensitivity             VARCHAR(10) NOT NULL DEFAULT 'low'
                          CHECK (sensitivity IN ('low', 'high')),
  content_flag            VARCHAR(20) DEFAULT NULL
                          CHECK (content_flag IN (NULL, 'spam', 'poisoning', 'hallucination', 'review_needed')),
  content_flag_reason     TEXT,
  content_flagged_by      UUID REFERENCES accounts(id),
  content_flagged_at      TIMESTAMPTZ,
  agorai_conversation_id  VARCHAR(100),
  created_by              UUID NOT NULL REFERENCES accounts(id),
  status                  VARCHAR(10) NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'locked', 'archived')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(slug, lang)
);

-- 4. topic_translations
CREATE TABLE topic_translations (
  topic_id        UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  translated_id   UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (topic_id, translated_id),
  CHECK (topic_id <> translated_id)
);

-- 5. chunks
CREATE TABLE chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content         TEXT NOT NULL,
  technical_detail TEXT,
  has_technical_detail BOOLEAN DEFAULT false,
  embedding       VECTOR(1024),
  trust_score     FLOAT DEFAULT 0,
  status          VARCHAR(15) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'disputed', 'retracted')),
  created_by      UUID NOT NULL REFERENCES accounts(id),
  valid_as_of     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. chunk_topics
CREATE TABLE chunk_topics (
  chunk_id    UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  topic_id    UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (chunk_id, topic_id)
);

-- 7. chunk_sources
CREATE TABLE chunk_sources (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id            UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  source_url          VARCHAR(2048),
  source_description  TEXT,
  added_by            UUID NOT NULL REFERENCES accounts(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. messages
CREATE TABLE messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id    UUID NOT NULL REFERENCES topics(id),
  account_id  UUID NOT NULL REFERENCES accounts(id),
  content     TEXT,
  level       SMALLINT NOT NULL CHECK (level IN (1, 2, 3)),
  type        VARCHAR(20) NOT NULL
              CHECK (type IN (
                'contribution', 'reply', 'edit',
                'flag', 'merge', 'revert', 'moderation_vote',
                'coordination', 'debug', 'protocol'
              )),
  parent_id   UUID REFERENCES messages(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at   TIMESTAMPTZ
);

-- 9. votes
CREATE TABLE votes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id),
  target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('message', 'policing_action')),
  target_id   UUID NOT NULL,
  value       VARCHAR(4) NOT NULL CHECK (value IN ('up', 'down')),
  reason_tag  VARCHAR(20)
              CHECK (reason_tag IN (
                'accurate', 'inaccurate',
                'relevant', 'off_topic',
                'well_sourced', 'unsourced',
                'fair', 'unfair',
                'sabotage'
              )),
  weight      FLOAT NOT NULL DEFAULT 1.0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, target_type, target_id)
);

-- 10. flags
CREATE TABLE flags (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id     UUID NOT NULL REFERENCES accounts(id),
  target_type     VARCHAR(10) NOT NULL CHECK (target_type IN ('message', 'account', 'chunk', 'topic')),
  target_id       UUID NOT NULL,
  reason          TEXT NOT NULL,
  detection_type  VARCHAR(20) NOT NULL DEFAULT 'manual'
                  CHECK (detection_type IN (
                    'manual', 'temporal_burst', 'network_cluster',
                    'creator_cluster', 'topic_concentration'
                  )),
  status          VARCHAR(15) NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'reviewing', 'dismissed', 'actioned')),
  reviewed_by     UUID REFERENCES accounts(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);

-- 11. subscriptions
CREATE TABLE subscriptions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            UUID NOT NULL REFERENCES accounts(id),
  type                  VARCHAR(10) NOT NULL CHECK (type IN ('topic', 'keyword', 'vector')),
  topic_id              UUID REFERENCES topics(id),
  keyword               VARCHAR(255),
  embedding             VECTOR(1024),
  similarity_threshold  FLOAT,
  lang                  VARCHAR(10),
  notification_method   VARCHAR(10) NOT NULL DEFAULT 'webhook'
                        CHECK (notification_method IN ('webhook', 'a2a', 'polling')),
  webhook_url           VARCHAR(2048),
  active                BOOLEAN DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
