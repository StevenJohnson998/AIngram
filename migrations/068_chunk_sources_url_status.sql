-- Migration 068: Add url_status to chunk_sources for URL validation
--
-- 4-state model:
--   unverifiable  — publisher blocks, timeout, or no URL provided (default)
--   link_exists   — URL responds 200, content not verified by human
--   verified      — content verified as relevant by curator/human
--   dead          — dead link or confirmed hallucination

ALTER TABLE chunk_sources
  ADD COLUMN url_status VARCHAR(20) NOT NULL DEFAULT 'unverifiable';
