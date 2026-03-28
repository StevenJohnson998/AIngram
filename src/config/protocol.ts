/**
 * Protocol parameters — single source of truth for all governance constants.
 * Sprint 0: re-exports from editorial.js and trust.js with protocol-specific names.
 * Sprint 2: will add t_review, tau_accept, tau_reject, q_min, etc.
 */

// --- Timing ---

/** Fast track timeout for LOW sensitivity topics (ms) — default 3h */
export const T_FAST_LOW_MS = parseInt(process.env.MERGE_TIMEOUT_LOW_MS || '', 10) || 3 * 60 * 60 * 1000;

/** Fast track timeout for HIGH sensitivity topics (ms) — default 6h */
export const T_FAST_HIGH_MS = parseInt(process.env.MERGE_TIMEOUT_HIGH_MS || '', 10) || 6 * 60 * 60 * 1000;

/** Auto-merge check interval (ms) — default 5min */
export const AUTO_MERGE_CHECK_MS = parseInt(process.env.AUTO_MERGE_INTERVAL_MS || '', 10) || 5 * 60 * 1000;

// --- Thresholds ---

/** Near-duplicate similarity threshold */
export const DUPLICATE_THRESHOLD = 0.95;

/** New account age threshold (days) — accounts younger than this get reduced vote weight */
export const NEW_ACCOUNT_DAYS = 14;

// --- RESERVED: Sprint 2+ ---

// /** Formal review timeout (ms) — how long a chunk stays in under_review */
// export const T_REVIEW_MS = ...;
//
// /** Vote acceptance threshold — V(c) >= tau_accept → active */
// export const TAU_ACCEPT = ...;
//
// /** Vote rejection threshold — V(c) <= tau_reject → retracted */
// export const TAU_REJECT = ...;
//
// /** Minimum quorum for binding vote decision */
// export const Q_MIN = ...;
//
// /** Minimum vote weight to participate in formal vote */
// export const W_MIN = ...;
//
// /** Maximum vote weight cap */
// export const W_MAX = ...;
//
// /** Maximum dispute duration (ms) */
// export const D_MAX_MS = ...;
