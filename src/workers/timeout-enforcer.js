/**
 * Timeout Enforcer — background job that enforces time-based lifecycle transitions.
 *
 * Runs every TIMEOUT_CHECK_MS (default 5 min) and handles:
 * 1. Fast-track merge: proposed chunks past T_FAST with no down-votes → active
 * 2. Review timeout: under_review chunks past T_REVIEW → retracted (reason: timeout)
 * 3. Dispute timeout: disputed chunks past T_DISPUTE → retracted (reason: timeout)
 *
 * All queries use FOR UPDATE SKIP LOCKED to prevent duplicate processing.
 */

const { getPool } = require('../config/database');
const {
  T_FAST_LOW_MS,
  T_FAST_HIGH_MS,
  T_REVIEW_MS,
  T_DISPUTE_MS,
  T_COPYRIGHT_REVIEW_DEADLINE_MS,
} = require('../config/protocol');
const chunkService = require('../services/chunk');
const formalVoteService = require('../services/formal-vote');
const reportService = require('../services/report');

const SYSTEM_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Fast-track merge: auto-accept proposed chunks with no objections after timeout.
 */
async function enforceFastTrack() {
  const pool = getPool();
  const client = await pool.connect();
  let mergedCount = 0;

  try {
    await client.query('BEGIN');

    // Find proposed chunks older than the shortest fast-track timeout
    const minAge = Math.min(T_FAST_LOW_MS, T_FAST_HIGH_MS);
    const cutoff = new Date(Date.now() - minAge);

    const { rows: candidates } = await client.query(
      `SELECT c.id, c.created_at, t.sensitivity
       FROM chunks c
       JOIN chunk_topics ct ON ct.chunk_id = c.id
       JOIN topics t ON t.id = ct.topic_id
       WHERE c.status = 'proposed' AND c.chunk_type = 'knowledge' AND c.created_at < $1
       ORDER BY c.created_at ASC
       FOR UPDATE OF c SKIP LOCKED`,
      [cutoff]
    );

    await client.query('COMMIT');

    for (const candidate of candidates) {
      const timeout = candidate.sensitivity === 'high' ? T_FAST_HIGH_MS : T_FAST_LOW_MS;
      const age = Date.now() - new Date(candidate.created_at).getTime();
      if (age < timeout) continue;

      // Check for down-votes (objections already escalate, but down-votes block auto-merge)
      const { rows: voteRows } = await pool.query(
        `SELECT COUNT(*)::int AS down_count
         FROM votes
         WHERE target_type = 'chunk' AND target_id = $1 AND value = 'down'`,
        [candidate.id]
      );

      if (voteRows[0].down_count > 0) continue;

      try {
        await chunkService.mergeChunk(candidate.id, SYSTEM_ACCOUNT_ID);
        mergedCount++;
      } catch (err) {
        if (err.code === 'NOT_FOUND') continue; // benign race
        console.error(`Fast-track merge failed for chunk ${candidate.id}:`, err.message);
      }
    }

    if (mergedCount > 0) {
      console.log(`Timeout enforcer: fast-track merged ${mergedCount} chunk(s)`);
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Fast-track enforcement error:', err.message);
  } finally {
    client.release();
  }

  return mergedCount;
}

/**
 * Review timeout: retract under_review chunks that exceeded T_REVIEW.
 * Skips chunks with active formal vote phases (those have their own deadlines).
 */
async function enforceReviewTimeout() {
  const pool = getPool();
  const cutoff = new Date(Date.now() - T_REVIEW_MS);

  const { rows } = await pool.query(
    `UPDATE chunks SET status = 'retracted', retract_reason = 'timeout', updated_at = now()
     WHERE status = 'under_review' AND under_review_at IS NOT NULL AND under_review_at < $1
       AND vote_phase IS NULL
     RETURNING id`,
    [cutoff]
  );

  for (const chunk of rows) {
    await pool.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES ($1, 'chunk_timeout', 'chunk', $2, $3)`,
      [SYSTEM_ACCOUNT_ID, chunk.id, JSON.stringify({ reason: 'review_timeout', timeout_ms: T_REVIEW_MS })]
    );
  }

  if (rows.length > 0) {
    console.log(`Timeout enforcer: retracted ${rows.length} chunk(s) from review timeout`);
  }

  return rows.length;
}

/**
 * Dispute timeout: retract disputed chunks that exceeded T_DISPUTE.
 */
async function enforceDisputeTimeout() {
  const pool = getPool();
  const cutoff = new Date(Date.now() - T_DISPUTE_MS);

  const { rows } = await pool.query(
    `UPDATE chunks SET status = 'retracted', retract_reason = 'timeout', updated_at = now()
     WHERE status = 'disputed' AND disputed_at IS NOT NULL AND disputed_at < $1
     RETURNING id`,
    [cutoff]
  );

  for (const chunk of rows) {
    await pool.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES ($1, 'chunk_timeout', 'chunk', $2, $3)`,
      [SYSTEM_ACCOUNT_ID, chunk.id, JSON.stringify({ reason: 'dispute_timeout', timeout_ms: T_DISPUTE_MS })]
    );
  }

  if (rows.length > 0) {
    console.log(`Timeout enforcer: retracted ${rows.length} chunk(s) from dispute timeout`);
  }

  return rows.length;
}

/**
 * Commit deadline: transition chunks from commit phase to reveal phase.
 * Voters who missed the commit window simply don't participate.
 */
async function enforceCommitDeadline() {
  const pool = getPool();
  const now = new Date();

  const { rows } = await pool.query(
    `UPDATE chunks SET vote_phase = 'reveal', updated_at = now()
     WHERE vote_phase = 'commit' AND commit_deadline_at IS NOT NULL AND commit_deadline_at < $1
     RETURNING id`,
    [now]
  );

  if (rows.length > 0) {
    console.log(`Timeout enforcer: transitioned ${rows.length} chunk(s) from commit to reveal phase`);
  }

  return rows.length;
}

/**
 * Reveal deadline: tally votes and resolve chunks past the reveal deadline.
 * Non-revealers are excluded from the tally (their vote doesn't count).
 */
async function enforceRevealDeadline() {
  const pool = getPool();
  const now = new Date();

  const { rows } = await pool.query(
    `SELECT id FROM chunks
     WHERE vote_phase = 'reveal' AND reveal_deadline_at IS NOT NULL AND reveal_deadline_at < $1`,
    [now]
  );

  let resolvedCount = 0;
  for (const chunk of rows) {
    try {
      const result = await formalVoteService.tallyAndResolve(chunk.id);
      if (result) resolvedCount++;
    } catch (err) {
      console.error(`Tally failed for chunk ${chunk.id}:`, err.message);
    }
  }

  if (resolvedCount > 0) {
    console.log(`Timeout enforcer: resolved ${resolvedCount} chunk(s) from reveal deadline`);
  }

  return resolvedCount;
}

/**
 * Copyright review deadline: auto-hide chunks from pending copyright reports
 * that have not been reviewed within T_COPYRIGHT_REVIEW_DEADLINE_MS.
 * Review-first approach: content stays visible while review is pending,
 * but auto-hides if no reviewer acts within the deadline.
 */
async function enforceCopyrightReviewDeadline() {
  const pool = getPool();
  const cutoff = new Date(Date.now() - T_COPYRIGHT_REVIEW_DEADLINE_MS);

  // Find pending copyright reports (on chunks) older than the deadline
  const { rows } = await pool.query(
    `SELECT r.id FROM reports r
     WHERE r.status = 'pending'
       AND r.content_type = 'chunk'
       AND r.reason ILIKE '%copyright%'
       AND r.created_at < $1
     ORDER BY r.created_at ASC
     LIMIT 50`,
    [cutoff]
  );

  let hiddenCount = 0;
  for (const report of rows) {
    try {
      const result = await reportService.autoHideFromReport(report.id);
      if (result) hiddenCount++;
    } catch (err) {
      console.error(`Copyright auto-hide failed for report ${report.id}:`, err.message);
    }
  }

  if (hiddenCount > 0) {
    console.log(`Timeout enforcer: auto-hidden ${hiddenCount} chunk(s) from copyright review deadline`);
  }

  return hiddenCount;
}

/**
 * Run all timeout checks. Called by the worker on interval.
 */
async function checkTimeouts() {
  await enforceFastTrack();
  await enforceCommitDeadline();
  await enforceRevealDeadline();
  await enforceReviewTimeout();
  await enforceDisputeTimeout();
  await enforceCopyrightReviewDeadline();
}

module.exports = {
  checkTimeouts,
  enforceFastTrack,
  enforceCommitDeadline,
  enforceRevealDeadline,
  enforceReviewTimeout,
  enforceDisputeTimeout,
  enforceCopyrightReviewDeadline,
};
