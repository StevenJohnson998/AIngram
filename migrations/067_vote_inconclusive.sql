-- Migration 067: Add vote_inconclusive_at for dead-end vote resolution
--
-- When tallyAndResolve() yields indeterminate or no_quorum, the changeset
-- was stuck in under_review with vote_phase='resolved' and no path forward.
-- Now: vote_phase resets to NULL, vote_inconclusive_at records the timestamp,
-- and the timeout enforcer auto-retracts after T_VOTE_INCONCLUSIVE_MS (48h).

ALTER TABLE changesets ADD COLUMN vote_inconclusive_at TIMESTAMPTZ;
