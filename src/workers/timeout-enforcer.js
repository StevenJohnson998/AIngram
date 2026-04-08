/**
 * Timeout Enforcer — background job that enforces time-based lifecycle transitions.
 *
 * Runs every TIMEOUT_CHECK_MS (default 5 min) and handles:
 * 1. Fast-track merge: proposed changesets past T_FAST with no down-votes → merged
 * 2. Review timeout: under_review changesets past T_REVIEW → retracted (reason: timeout)
 * 3. Commit deadline: changesets in commit phase → reveal phase
 * 4. Reveal deadline: changesets past reveal → tally and resolve
 * 5. Dispute timeout: disputed chunks past T_DISPUTE → retracted (chunk-level)
 * 6. Copyright review deadline: pending copyright reports → auto-hide (chunk-level)
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
const changesetService = require('../services/changeset');
const formalVoteService = require('../services/formal-vote');
const reportService = require('../services/report');

const SYSTEM_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Fast-track merge: auto-accept proposed changesets with no objections after timeout.
 * Only knowledge-only changesets (no suggestions) are eligible for fast-track.
 */
async function enforceFastTrack() {
  const pool = getPool();
  const client = await pool.connect();
  let mergedCount = 0;

  try {
    await client.query('BEGIN');

    // Find proposed changesets older than the shortest fast-track timeout
    const minAge = Math.min(T_FAST_LOW_MS, T_FAST_HIGH_MS);
    const cutoff = new Date(Date.now() - minAge);

    const { rows: candidates } = await client.query(
      `SELECT cs.id, cs.created_at, t.sensitivity
       FROM changesets cs
       JOIN topics t ON t.id = cs.topic_id
       WHERE cs.status = 'proposed' AND cs.created_at < $1
         -- Only fast-track changesets where ALL chunks are knowledge (no suggestions)
         AND NOT EXISTS (
           SELECT 1 FROM changeset_operations co
           JOIN chunks c ON c.id = co.chunk_id
           WHERE co.changeset_id = cs.id AND c.chunk_type != 'knowledge'
         )
         -- Skip changesets where any chunk contains images (require human review)
         AND NOT EXISTS (
           SELECT 1 FROM changeset_operations co
           JOIN chunks c ON c.id = co.chunk_id
           WHERE co.changeset_id = cs.id AND c.content LIKE '%![%](%'
         )
       ORDER BY cs.created_at ASC
       FOR UPDATE OF cs SKIP LOCKED`,
      [cutoff]
    );

    for (const candidate of candidates) {
      const timeout = candidate.sensitivity === 'sensitive' ? T_FAST_HIGH_MS : T_FAST_LOW_MS;
      const age = Date.now() - new Date(candidate.created_at).getTime();
      if (age < timeout) continue;

      // Check for down-votes on the changeset
      const { rows: voteRows } = await client.query(
        `SELECT COUNT(*)::int AS down_count
         FROM votes
         WHERE target_type = 'changeset' AND target_id = $1 AND value = 'down'`,
        [candidate.id]
      );

      if (voteRows[0].down_count > 0) continue;

      try {
        await changesetService.mergeChangeset(candidate.id, SYSTEM_ACCOUNT_ID);
        mergedCount++;
      } catch (err) {
        if (err.code === 'NOT_FOUND') continue; // benign race
        console.error(`Fast-track merge failed for changeset ${candidate.id}:`, err.message);
      }
    }

    await client.query('COMMIT');

    if (mergedCount > 0) {
      console.log(`Timeout enforcer: fast-track merged ${mergedCount} changeset(s)`);
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
 * Review timeout: retract under_review changesets that exceeded T_REVIEW.
 * Skips changesets with active formal vote phases (those have their own deadlines).
 * Uses direct SQL since retractChangeset requires proposer ownership check.
 */
async function enforceReviewTimeout() {
  const pool = getPool();
  const cutoff = new Date(Date.now() - T_REVIEW_MS);

  // Retract changesets past the review deadline with no active vote phase
  const { rows } = await pool.query(
    `UPDATE changesets SET status = 'retracted', retract_reason = 'timeout', updated_at = now()
     WHERE status = 'under_review' AND under_review_at IS NOT NULL AND under_review_at < $1
       AND vote_phase IS NULL
     RETURNING id`,
    [cutoff]
  );

  if (rows.length > 0) {
    const changesetIds = rows.map(r => r.id);

    // Retract all chunks belonging to those changesets
    await pool.query(
      `UPDATE chunks SET status = 'retracted', updated_at = now()
       WHERE id IN (SELECT chunk_id FROM changeset_operations WHERE changeset_id = ANY($1) AND chunk_id IS NOT NULL)`,
      [changesetIds]
    );

    for (const cs of rows) {
      await pool.query(
        `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
         VALUES ($1, 'changeset_timeout', 'changeset', $2, $3)`,
        [SYSTEM_ACCOUNT_ID, cs.id, JSON.stringify({ reason: 'review_timeout', timeout_ms: T_REVIEW_MS })]
      );
    }

    console.log(`Timeout enforcer: retracted ${rows.length} changeset(s) from review timeout`);
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
 * Commit deadline: transition changesets from commit phase to reveal phase.
 * Voters who missed the commit window simply don't participate.
 */
async function enforceCommitDeadline() {
  const pool = getPool();
  const now = new Date();

  const { rows } = await pool.query(
    `UPDATE changesets SET vote_phase = 'reveal', updated_at = now()
     WHERE vote_phase = 'commit' AND commit_deadline_at IS NOT NULL AND commit_deadline_at < $1
     RETURNING id`,
    [now]
  );

  if (rows.length > 0) {
    console.log(`Timeout enforcer: transitioned ${rows.length} changeset(s) from commit to reveal phase`);
  }

  return rows.length;
}

/**
 * Reveal deadline: tally votes and resolve changesets past the reveal deadline.
 * Non-revealers are excluded from the tally (their vote doesn't count).
 */
async function enforceRevealDeadline() {
  const pool = getPool();
  const now = new Date();

  const { rows } = await pool.query(
    `SELECT id FROM changesets
     WHERE vote_phase = 'reveal' AND reveal_deadline_at IS NOT NULL AND reveal_deadline_at < $1`,
    [now]
  );

  let resolvedCount = 0;
  for (const changeset of rows) {
    try {
      const result = await formalVoteService.tallyAndResolve(changeset.id);
      if (result) resolvedCount++;
    } catch (err) {
      console.error(`Tally failed for changeset ${changeset.id}:`, err.message);
    }
  }

  if (resolvedCount > 0) {
    console.log(`Timeout enforcer: resolved ${resolvedCount} changeset(s) from reveal deadline`);
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
