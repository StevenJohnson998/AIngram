/**
 * Protocol parameters — single source of truth for all governance constants.
 * All values configurable via environment variables for testing.
 *
 * Naming convention:
 *   T_*   = timeout durations (ms)
 *   TAU_* = vote thresholds
 *   Q_*   = quorum requirements
 *   W_*   = vote weight bounds
 */

// --- Timing ---

/** Fast track timeout for LOW sensitivity topics (ms) — default 3h */
export const T_FAST_LOW_MS = parseInt(process.env.MERGE_TIMEOUT_LOW_MS || '', 10) || 3 * 60 * 60 * 1000;

/** Fast track timeout for HIGH sensitivity topics (ms) — default 6h */
export const T_FAST_HIGH_MS = parseInt(process.env.MERGE_TIMEOUT_HIGH_MS || '', 10) || 6 * 60 * 60 * 1000;

/** Formal review timeout (ms) — max time in under_review before retraction — default 24h */
export const T_REVIEW_MS = parseInt(process.env.REVIEW_TIMEOUT_MS || '', 10) || 24 * 60 * 60 * 1000;

/** Dispute timeout (ms) — max time in disputed before retraction — default 48h */
export const T_DISPUTE_MS = parseInt(process.env.DISPUTE_TIMEOUT_MS || '', 10) || 48 * 60 * 60 * 1000;

/** Timeout enforcer check interval (ms) — default 5min */
export const TIMEOUT_CHECK_MS = parseInt(process.env.TIMEOUT_CHECK_INTERVAL_MS || '', 10) || 5 * 60 * 1000;

// --- Thresholds ---

/** Near-duplicate similarity threshold */
export const DUPLICATE_THRESHOLD = 0.95;

/** New account age threshold (days) — accounts younger than this get reduced vote weight */
export const NEW_ACCOUNT_DAYS = 14;

/** Maximum resubmission attempts for a retracted chunk */
export const MAX_RESUBMIT_COUNT = 3;

// --- Vote thresholds (Sprint 3 — defined now for protocol.ts completeness) ---

/** Vote acceptance threshold — V(c) >= TAU_ACCEPT → active */
export const TAU_ACCEPT = parseFloat(process.env.TAU_ACCEPT || '') || 0.6;

/** Vote rejection threshold — V(c) <= TAU_REJECT → retracted */
export const TAU_REJECT = parseFloat(process.env.TAU_REJECT || '') || -0.3;

/** Minimum quorum for binding vote decision */
export const Q_MIN = parseInt(process.env.Q_MIN || '', 10) || 3;

/** Minimum vote weight to participate in formal vote */
export const W_MIN = parseFloat(process.env.W_MIN || '') || 0.1;

/** Maximum vote weight cap */
export const W_MAX = parseFloat(process.env.W_MAX || '') || 5.0;

// --- Commit-Reveal Timing ---

/** Commit phase duration (ms) — how long voters can submit hashed votes — default 24h */
export const T_COMMIT_MS = parseInt(process.env.T_COMMIT_MS || '', 10) || 24 * 60 * 60 * 1000;

/** Reveal phase duration (ms) — how long voters can reveal after commit deadline — default 12h */
export const T_REVEAL_MS = parseInt(process.env.T_REVEAL_MS || '', 10) || 12 * 60 * 60 * 1000;

// --- Objection ---

/** Valid reason tags for objections */
export const OBJECTION_REASON_TAGS = [
  'inaccurate',
  'unsourced',
  'redundant',
  'harmful',
  'unclear',
  'copyright',
] as const;

export type ObjectionReason = typeof OBJECTION_REASON_TAGS[number];

// --- Reputation Incentives ---

/** Deliberation bonus — reputation reward for voters who discussed before voting */
export const DELTA_DELIB = parseFloat(process.env.DELTA_DELIB || '') || 0.02;

/** Dissent incentive — reputation reward for vindicated minority voters */
export const DELTA_DISSENT = parseFloat(process.env.DELTA_DISSENT || '') || 0.05;

// --- Legacy aliases (consumed by auto-merge.js, will be removed after Sprint 2) ---

export const MERGE_TIMEOUT_LOW_SENSITIVITY_MS = T_FAST_LOW_MS;
export const MERGE_TIMEOUT_HIGH_SENSITIVITY_MS = T_FAST_HIGH_MS;
export const AUTO_MERGE_CHECK_INTERVAL_MS = TIMEOUT_CHECK_MS;
