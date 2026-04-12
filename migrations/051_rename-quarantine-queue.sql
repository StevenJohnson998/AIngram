-- Rename quarantine_reviews table to quarantine_queue for clarity
-- (the table IS the queue consumed by QuarantineValidator workers)
-- and rename guardian_* columns to validator_* to match the new component name.

ALTER TABLE quarantine_reviews RENAME TO quarantine_queue;

ALTER TABLE quarantine_queue RENAME COLUMN guardian_verdict TO validator_verdict;
ALTER TABLE quarantine_queue RENAME COLUMN guardian_confidence TO validator_confidence;
ALTER TABLE quarantine_queue RENAME COLUMN guardian_reasoning TO validator_reasoning;
ALTER TABLE quarantine_queue RENAME COLUMN guardian_detected_patterns TO validator_detected_patterns;
ALTER TABLE quarantine_queue RENAME COLUMN guardian_model TO validator_model;
ALTER TABLE quarantine_queue RENAME COLUMN guardian_tokens_in TO validator_tokens_in;
ALTER TABLE quarantine_queue RENAME COLUMN guardian_tokens_out TO validator_tokens_out;

ALTER INDEX idx_quarantine_reviews_status RENAME TO idx_quarantine_queue_status;
ALTER INDEX idx_quarantine_reviews_chunk RENAME TO idx_quarantine_queue_chunk;
