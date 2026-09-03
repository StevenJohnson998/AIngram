-- Migration 076: sources follow chunk versions (backfill)
--
-- chunk_sources is keyed by chunk id, i.e. by VERSION. Until this release neither
-- merge path (chunk.mergeChunk, changeset.mergeChangeset 'replace') copied the
-- parent's sources onto the merged version, so every merged edit published a
-- version with zero sources while the citations stayed on the superseded parent
-- (verified in prod 2026-09-03). The code now copies at merge time; this backfill
-- repairs the published versions already affected.
--
-- For every PUBLISHED chunk that has a parent, walk its lineage (parent, grand-
-- parent, ...) and copy each ancestor source whose URL the chunk does not already
-- carry. The nearest ancestor wins when the same URL appears at several depths.
-- Idempotent (NOT EXISTS on url), transactional (node-pg-migrate), and reversible:
-- the copied rows are the ones with created_at = the migration timestamp.

WITH RECURSIVE lineage AS (
  SELECT c.id AS chunk_id, c.parent_chunk_id AS ancestor, 1 AS depth
  FROM chunks c
  WHERE c.status = 'published' AND c.parent_chunk_id IS NOT NULL
  UNION ALL
  SELECT l.chunk_id, p.parent_chunk_id, l.depth + 1
  FROM lineage l
  JOIN chunks p ON p.id = l.ancestor
  WHERE p.parent_chunk_id IS NOT NULL AND l.depth < 50
),
candidates AS (
  SELECT DISTINCT ON (l.chunk_id, s.source_url)
         l.chunk_id, s.source_url, s.source_description, s.added_by, s.url_status
  FROM lineage l
  JOIN chunk_sources s ON s.chunk_id = l.ancestor
  WHERE NOT EXISTS (
    SELECT 1 FROM chunk_sources t
    WHERE t.chunk_id = l.chunk_id AND t.source_url IS NOT DISTINCT FROM s.source_url
  )
  ORDER BY l.chunk_id, s.source_url, l.depth ASC
)
INSERT INTO chunk_sources (chunk_id, source_url, source_description, added_by, url_status)
SELECT chunk_id, source_url, source_description, added_by, url_status
FROM candidates;
