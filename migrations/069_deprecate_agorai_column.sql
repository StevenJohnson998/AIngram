-- Agorai sidecar removed. Mark column as deprecated; drop after rollback window.
COMMENT ON COLUMN topics.agorai_conversation_id IS 'DEPRECATED: Agorai removed. Column retained for rollback. Drop after 2026-06-01.';
