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

// --- Takedown ---

/** Counter-notice legal delay before auto-restoration (ms) — default 14 days (EU Art. 17 simplified) */
export const T_COUNTER_NOTICE_DELAY_MS = parseInt(process.env.T_COUNTER_NOTICE_DELAY_MS || '', 10) || 14 * 24 * 60 * 60 * 1000;

/** Counter-notice restoration check interval (ms) — default 1h */
export const T_RESTORATION_CHECK_MS = parseInt(process.env.T_RESTORATION_CHECK_INTERVAL_MS || '', 10) || 60 * 60 * 1000;

/** Copyright review deadline (ms) — pending reports auto-hide chunk after this delay — default 24h */
export const T_COPYRIGHT_REVIEW_DEADLINE_MS = parseInt(process.env.T_COPYRIGHT_REVIEW_DEADLINE_MS || '', 10) || 24 * 60 * 60 * 1000;

/** Minimum reputation_copyright required for immediate (fast-track) takedown */
export const MIN_REP_COPYRIGHT_FAST_TAKEDOWN = parseFloat(process.env.MIN_REP_COPYRIGHT_FAST_TAKEDOWN || '') || 0.8;

/** Reporter suspension threshold: false positive rate (0-1) on 10+ resolved reports */
export const REPORTER_SUSPENSION_FP_THRESHOLD = 0.6;

/** Minimum resolved reports before suspension can trigger */
export const REPORTER_SUSPENSION_MIN_REPORTS = 10;

/** Reporter suspension duration (ms) — default 30 days */
export const REPORTER_SUSPENSION_DURATION_MS = parseInt(process.env.REPORTER_SUSPENSION_DURATION_MS || '', 10) || 30 * 24 * 60 * 60 * 1000;

/** Priority escalation: max reports per topic in 48h before flagging as high priority */
export const COPYRIGHT_PRIORITY_TOPIC_THRESHOLD = 3;

/** Priority escalation: max reports per reporter in 24h before flagging */
export const COPYRIGHT_PRIORITY_REPORTER_THRESHOLD = 5;

// --- Suggestions (Sprint 7) ---

/** Suggestion vote commit phase (ms) — default 48h (longer than content) */
export const T_SUGGESTION_COMMIT_MS = parseInt(process.env.T_SUGGESTION_COMMIT_MS || '', 10) || 48 * 60 * 60 * 1000;

/** Suggestion vote reveal phase (ms) — default 24h (longer than content) */
export const T_SUGGESTION_REVEAL_MS = parseInt(process.env.T_SUGGESTION_REVEAL_MS || '', 10) || 24 * 60 * 60 * 1000;

/** Suggestion acceptance threshold — higher bar than content (0.6) */
export const TAU_SUGGESTION_ACCEPT = parseFloat(process.env.TAU_SUGGESTION_ACCEPT || '') || 0.7;

/** Suggestion rejection threshold */
export const TAU_SUGGESTION_REJECT = parseFloat(process.env.TAU_SUGGESTION_REJECT || '') || -0.3;

/** Suggestion minimum quorum — higher than content (3) */
export const Q_SUGGESTION_MIN = parseInt(process.env.Q_SUGGESTION_MIN || '', 10) || 5;

/** Minimum tier to vote on suggestions */
export const SUGGESTION_VOTE_MIN_TIER = 2;

/** Reputation bonus for author when suggestion reaches active */
export const DELTA_SUGGESTION_APPROVED = parseFloat(process.env.DELTA_SUGGESTION_APPROVED || '') || 0.08;

/** Valid suggestion categories */
export const SUGGESTION_CATEGORIES = [
  'governance',
  'ui_ux',
  'technical',
  'new_feature',
  'documentation',
  'other',
] as const;

export type SuggestionCategory = typeof SUGGESTION_CATEGORIES[number];

/** Copyright analytics refresh interval (ms) — default 6h */
export const T_ANALYTICS_REFRESH_MS = parseInt(process.env.T_ANALYTICS_REFRESH_MS || '', 10) || 6 * 60 * 60 * 1000;

/** Dynamic directives regeneration interval (ms) — default 24h */
export const T_DIRECTIVES_REGEN_MS = parseInt(process.env.T_DIRECTIVES_REGEN_MS || '', 10) || 24 * 60 * 60 * 1000;

// --- Legacy aliases (consumed by auto-merge.js, will be removed after Sprint 2) ---

export const MERGE_TIMEOUT_LOW_SENSITIVITY_MS = T_FAST_LOW_MS;
export const MERGE_TIMEOUT_HIGH_SENSITIVITY_MS = T_FAST_HIGH_MS;
export const AUTO_MERGE_CHECK_INTERVAL_MS = TIMEOUT_CHECK_MS;
