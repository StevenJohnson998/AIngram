/**
 * Formal vote service — commit-reveal voting protocol for changeset governance.
 * Sprint 3: implements Paper 3 (Deliberative Curation) formal voting.
 *
 * Flow: changeset enters under_review → startCommitPhase → voters commit hashes →
 *       commit deadline → reveal phase → voters reveal → tally → decision
 *
 * The formal_votes table uses a `changeset_id` column to reference the changeset
 * being voted on. The legacy `chunk_id` column is kept for backward compatibility.
 */

const { getPool } = require('../config/database');
const trustConfig = require('../config/trust');
const { isVoteSuspended } = require('./sanction');
const { calculateVoteWeight } = require('../../build/domain/vote-weight');
const {
  verifyReveal,
  clampWeight,
  computeVoteScore,
  evaluateDecision,
  isValidFormalReasonTag,
  FORMAL_REASON_TAGS,
} = require('../../build/domain/formal-vote');
const {
  T_COMMIT_MS,
  T_REVEAL_MS,
  TAU_ACCEPT,
  TAU_REJECT,
  Q_MIN,
  W_MIN,
  W_MAX,
  NEW_ACCOUNT_DAYS,
  T_SUGGESTION_COMMIT_MS,
  T_SUGGESTION_REVEAL_MS,
  TAU_SUGGESTION_ACCEPT,
  TAU_SUGGESTION_REJECT,
  Q_SUGGESTION_MIN,
  SUGGESTION_VOTE_MIN_TIER,
  DELTA_SUGGESTION_APPROVED,
} = require('../../build/config/protocol');
const changesetService = require('./changeset');

/**
 * Start the commit phase for a changeset entering under_review.
 * Called after the OBJECT transition in escalateToReview.
 */
async function startCommitPhase(changesetId) {
  const pool = getPool();

  // Detect if this is a suggestion changeset by checking for suggestion chunks
  // among the changeset's operations
  const { rows: suggestionRows } = await pool.query(
    `SELECT c.chunk_type FROM changeset_operations co
     JOIN chunks c ON c.id = co.chunk_id
     WHERE co.changeset_id = $1 AND c.chunk_type = 'suggestion'
     LIMIT 1`,
    [changesetId]
  );
  const isSuggestion = suggestionRows.length > 0;
  const commitMs = isSuggestion ? T_SUGGESTION_COMMIT_MS : T_COMMIT_MS;
  const revealMs = isSuggestion ? T_SUGGESTION_REVEAL_MS : T_REVEAL_MS;

  const commitDeadline = new Date(Date.now() + commitMs);
  const revealDeadline = new Date(commitDeadline.getTime() + revealMs);

  const { rows } = await pool.query(
    `UPDATE changesets
     SET vote_phase = 'commit',
         commit_deadline_at = $2,
         reveal_deadline_at = $3,
         updated_at = now()
     WHERE id = $1 AND status = 'under_review'
     RETURNING id, vote_phase, commit_deadline_at, reveal_deadline_at`,
    [changesetId, commitDeadline, revealDeadline]
  );

  if (rows.length === 0) {
    throw Object.assign(
      new Error('Changeset not found or not under_review'),
      { code: 'NOT_FOUND' }
    );
  }

  return rows[0];
}

/**
 * Commit a hashed vote during the commit phase.
 * Validates: changeset in commit phase, account active with contribution, not self-vote, weight >= W_MIN.
 */
async function commitVote({ accountId, changesetId, commitHash }) {
  const pool = getPool();

  // Validate changeset is in commit phase
  const { rows: csRows } = await pool.query(
    `SELECT cs.id, cs.vote_phase, cs.commit_deadline_at, cs.proposed_by,
            EXISTS(
              SELECT 1 FROM changeset_operations co
              JOIN chunks c ON c.id = co.chunk_id
              WHERE co.changeset_id = cs.id AND c.chunk_type = 'suggestion'
            ) AS is_suggestion
     FROM changesets cs WHERE cs.id = $1`,
    [changesetId]
  );
  if (csRows.length === 0) {
    throw Object.assign(new Error('Changeset not found'), { code: 'NOT_FOUND' });
  }
  const cs = csRows[0];

  if (cs.vote_phase !== 'commit') {
    throw Object.assign(
      new Error(`Cannot commit vote: changeset is in '${cs.vote_phase || 'no vote'}' phase`),
      { code: 'INVALID_PHASE' }
    );
  }

  if (new Date() > new Date(cs.commit_deadline_at)) {
    throw Object.assign(
      new Error('Commit phase has ended'),
      { code: 'DEADLINE_PASSED' }
    );
  }

  // Self-vote check: cannot vote on own changeset
  if (cs.proposed_by === accountId) {
    throw Object.assign(new Error('Cannot vote on own content'), { code: 'SELF_VOTE' });
  }

  // Validate account
  const { rows: accountRows } = await pool.query(
    `SELECT id, status, first_contribution_at, created_at, reputation_contribution
     FROM accounts WHERE id = $1`,
    [accountId]
  );
  if (accountRows.length === 0) {
    throw Object.assign(new Error('Account not found'), { code: 'NOT_FOUND' });
  }
  const account = accountRows[0];

  if (account.status !== 'active') {
    throw Object.assign(new Error('Only active accounts can vote'), { code: 'FORBIDDEN' });
  }
  if (!account.first_contribution_at) {
    throw Object.assign(
      new Error('Cannot vote before making a first contribution'),
      { code: 'VOTE_LOCKED' }
    );
  }

  // Check vote suspension
  if (await isVoteSuspended(accountId)) {
    throw Object.assign(
      new Error('Account has an active vote suspension'),
      { code: 'VOTE_SUSPENDED' }
    );
  }

  // Suggestion changesets require higher tier to vote
  if (cs.is_suggestion) {
    const { rows: tierRows } = await pool.query(
      'SELECT tier FROM accounts WHERE id = $1', [accountId]
    );
    if ((tierRows[0]?.tier || 0) < SUGGESTION_VOTE_MIN_TIER) {
      throw Object.assign(
        new Error(`Voting on suggestions requires Tier ${SUGGESTION_VOTE_MIN_TIER}+`),
        { code: 'TIER_TOO_LOW' }
      );
    }
  }

  // Compute weight and reject if too low (before clamping)
  const rawWeight = calculateVoteWeight({
    accountCreatedAt: new Date(account.created_at),
    newAccountThresholdDays: NEW_ACCOUNT_DAYS,
    weightNew: trustConfig.VOTE_WEIGHT_NEW_ACCOUNT,
    weightEstablished: trustConfig.VOTE_WEIGHT_ESTABLISHED,
    voterReputation: account.reputation_contribution || 0.5,
    voterRepBase: trustConfig.VOTER_REP_BASE,
  });

  if (rawWeight < W_MIN) {
    throw Object.assign(
      new Error(`Vote weight ${rawWeight.toFixed(3)} below minimum ${W_MIN}`),
      { code: 'WEIGHT_TOO_LOW' }
    );
  }
  const weight = clampWeight(rawWeight, W_MIN, W_MAX);

  // Upsert formal vote (commit phase only stores hash + weight)
  // NOTE: using changeset_id column
  const { rows } = await pool.query(
    `INSERT INTO formal_votes (changeset_id, account_id, commit_hash, weight)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (changeset_id, account_id)
     DO UPDATE SET commit_hash = $3, weight = $4, committed_at = now(),
                   vote_value = NULL, reason_tag = NULL, salt = NULL, revealed_at = NULL
     RETURNING *`,
    [changesetId, accountId, commitHash, weight]
  );

  return rows[0];
}

/**
 * Reveal a previously committed vote during the reveal phase.
 * Validates: changeset in reveal phase, hash match, valid reason tag.
 */
async function revealVote({ accountId, changesetId, voteValue, reasonTag, salt }) {
  const pool = getPool();

  // Validate changeset is in reveal phase
  const { rows: csRows } = await pool.query(
    `SELECT id, vote_phase, reveal_deadline_at FROM changesets WHERE id = $1`,
    [changesetId]
  );
  if (csRows.length === 0) {
    throw Object.assign(new Error('Changeset not found'), { code: 'NOT_FOUND' });
  }
  const cs = csRows[0];

  if (cs.vote_phase !== 'reveal') {
    throw Object.assign(
      new Error(`Cannot reveal vote: changeset is in '${cs.vote_phase || 'no vote'}' phase`),
      { code: 'INVALID_PHASE' }
    );
  }

  if (new Date() > new Date(cs.reveal_deadline_at)) {
    throw Object.assign(
      new Error('Reveal phase has ended'),
      { code: 'DEADLINE_PASSED' }
    );
  }

  // Validate vote_value
  if (![-1, 0, 1].includes(voteValue)) {
    throw Object.assign(
      new Error('vote_value must be -1, 0, or 1'),
      { code: 'VALIDATION_ERROR' }
    );
  }

  // Validate reason tag is mandatory and valid
  if (!reasonTag) {
    throw Object.assign(
      new Error('reason_tag is required for formal votes'),
      { code: 'VALIDATION_ERROR' }
    );
  }
  if (!isValidFormalReasonTag(reasonTag)) {
    throw Object.assign(
      new Error(`Invalid reason_tag '${reasonTag}'. Valid: ${FORMAL_REASON_TAGS.join(', ')}`),
      { code: 'VALIDATION_ERROR' }
    );
  }

  // Fetch the committed vote
  // NOTE: using changeset_id column
  const { rows: voteRows } = await pool.query(
    `SELECT * FROM formal_votes WHERE changeset_id = $1 AND account_id = $2`,
    [changesetId, accountId]
  );
  if (voteRows.length === 0) {
    throw Object.assign(
      new Error('No committed vote found for this changeset'),
      { code: 'NOT_FOUND' }
    );
  }
  const committedVote = voteRows[0];

  if (committedVote.revealed_at) {
    throw Object.assign(
      new Error('Vote already revealed'),
      { code: 'ALREADY_REVEALED' }
    );
  }

  // Verify hash matches
  if (!verifyReveal(committedVote.commit_hash, voteValue, reasonTag, salt)) {
    throw Object.assign(
      new Error('Hash mismatch: reveal does not match commitment'),
      { code: 'HASH_MISMATCH' }
    );
  }

  // Update vote with revealed data
  // NOTE: using changeset_id column
  const { rows } = await pool.query(
    `UPDATE formal_votes
     SET vote_value = $3, reason_tag = $4, salt = $5, revealed_at = now()
     WHERE changeset_id = $1 AND account_id = $2
     RETURNING *`,
    [changesetId, accountId, voteValue, reasonTag, salt]
  );

  return rows[0];
}

/**
 * Tally all revealed votes and resolve the changeset's fate.
 * Uses FOR UPDATE SKIP LOCKED to prevent concurrent tally races.
 */
async function tallyAndResolve(changesetId) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock the changeset row to prevent concurrent tally
    const { rows: csRows } = await client.query(
      `SELECT id, status, vote_phase, proposed_by FROM changesets
       WHERE id = $1 AND vote_phase IN ('reveal', 'commit')
       FOR UPDATE SKIP LOCKED`,
      [changesetId]
    );

    if (csRows.length === 0) {
      await client.query('ROLLBACK');
      return null; // Already resolved or locked by another process
    }

    const changeset = csRows[0];

    // Detect if this is a suggestion changeset
    const { rows: suggestionRows } = await client.query(
      `SELECT 1 FROM changeset_operations co
       JOIN chunks c ON c.id = co.chunk_id
       WHERE co.changeset_id = $1 AND c.chunk_type = 'suggestion'
       LIMIT 1`,
      [changesetId]
    );
    const isSuggestionChangeset = suggestionRows.length > 0;

    // Fetch all revealed votes
    // NOTE: using changeset_id column
    const { rows: votes } = await client.query(
      `SELECT vote_value, weight FROM formal_votes
       WHERE changeset_id = $1 AND revealed_at IS NOT NULL`,
      [changesetId]
    );

    const revealedCount = votes.length;
    const weightedVotes = votes.map(v => ({
      weight: v.weight,
      voteValue: v.vote_value,
    }));

    const score = computeVoteScore(weightedVotes);
    const qMin = isSuggestionChangeset ? Q_SUGGESTION_MIN : Q_MIN;
    const tauAccept = isSuggestionChangeset ? TAU_SUGGESTION_ACCEPT : TAU_ACCEPT;
    const tauReject = isSuggestionChangeset ? TAU_SUGGESTION_REJECT : TAU_REJECT;
    const decision = evaluateDecision(score, revealedCount, qMin, tauAccept, tauReject);

    // Update changeset vote metadata
    await client.query(
      `UPDATE changesets SET vote_phase = 'resolved', vote_score = $2, updated_at = now()
       WHERE id = $1`,
      [changesetId, score]
    );

    const action = decision === 'accept' ? 'changeset_vote_accepted'
      : decision === 'reject' ? 'changeset_vote_rejected'
      : 'changeset_vote_indeterminate';
    await client.query(
      `INSERT INTO activity_log (action, target_type, target_id, metadata)
       VALUES ($1, 'changeset', $2, $3)`,
      [action, changesetId, JSON.stringify({ score, revealedCount, decision })]
    );

    // COMMIT first to release the FOR UPDATE lock before calling merge/reject,
    // which acquire their own locks on the changeset row via separate connections.
    await client.query('COMMIT');

    // Apply decision via changeset service (outside transaction to avoid deadlock)
    if (decision === 'accept') {
      await changesetService.mergeChangeset(changesetId, changesetService.SYSTEM_ACCOUNT_ID);
    } else if (decision === 'reject') {
      await changesetService.rejectChangeset(changesetId, {
        reason: 'Formal vote rejected',
        rejectedBy: changesetService.SYSTEM_ACCOUNT_ID,
      });
    }
    // 'indeterminate': changeset stays under_review, only vote_phase is resolved

    // Post-tally: award deliberation bonus (fire-and-forget)
    // Uses changesetId — the deliberation bonus function targets the changeset proposer
    const reputationService = require('./reputation');
    reputationService.awardDeliberationBonus(changesetId)
      .catch(err => console.error('Deliberation bonus failed:', err.message));

    // Recalculate trust scores for all chunks in the changeset after formal vote resolution
    reputationService.recalculateChunkTrust(changesetId)
      .catch(err => console.error('Chunk trust recalc after tally failed:', err.message));

    // Suggestion approved: award reputation bonus to changeset proposer
    if (isSuggestionChangeset && decision === 'accept') {
      (async () => {
        try {
          if (changeset.proposed_by) {
            await pool.query(
              `UPDATE accounts SET reputation_contribution = LEAST(1.0, reputation_contribution + $2)
               WHERE id = $1`,
              [changeset.proposed_by, DELTA_SUGGESTION_APPROVED]
            );
          }
        } catch (err) {
          console.error('Suggestion approval bonus failed:', err.message);
        }
      })();
    }

    return { changesetId, score, revealedCount, decision };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get the current vote status for a changeset.
 * Phase-aware: hides individual votes during commit/reveal phases.
 */
async function getVoteStatus(changesetId, requestingAccountId) {
  const pool = getPool();

  const { rows: csRows } = await pool.query(
    `SELECT id, status, vote_phase, commit_deadline_at, reveal_deadline_at, vote_score
     FROM changesets WHERE id = $1`,
    [changesetId]
  );

  if (csRows.length === 0) {
    throw Object.assign(new Error('Changeset not found'), { code: 'NOT_FOUND' });
  }
  const cs = csRows[0];

  if (!cs.vote_phase) {
    return { phase: null, message: 'No formal vote active' };
  }

  // Detect if suggestion changeset (for threshold display in resolved phase)
  const { rows: suggestionRows } = await pool.query(
    `SELECT 1 FROM changeset_operations co
     JOIN chunks c ON c.id = co.chunk_id
     WHERE co.changeset_id = $1 AND c.chunk_type = 'suggestion'
     LIMIT 1`,
    [changesetId]
  );
  const isSug = suggestionRows.length > 0;

  // Count totals
  // NOTE: using changeset_id column
  const { rows: countRows } = await pool.query(
    `SELECT
       COUNT(*)::int AS commit_count,
       COUNT(*) FILTER (WHERE revealed_at IS NOT NULL)::int AS revealed_count
     FROM formal_votes WHERE changeset_id = $1`,
    [changesetId]
  );
  const { commit_count, revealed_count } = countRows[0];

  // Check if requesting account has voted
  let hasCommitted = false;
  let hasRevealed = false;
  if (requestingAccountId) {
    const { rows: myVote } = await pool.query(
      `SELECT revealed_at FROM formal_votes
       WHERE changeset_id = $1 AND account_id = $2`,
      [changesetId, requestingAccountId]
    );
    if (myVote.length > 0) {
      hasCommitted = true;
      hasRevealed = !!myVote[0].revealed_at;
    }
  }

  if (cs.vote_phase === 'commit') {
    return {
      phase: 'commit',
      status: 'voting_in_progress',
      results: 'hidden',
      commitDeadline: cs.commit_deadline_at,
      revealDeadline: cs.reveal_deadline_at,
      commitCount: commit_count,
      hasCommitted,
    };
  }

  if (cs.vote_phase === 'reveal') {
    return {
      phase: 'reveal',
      status: 'voting_in_progress',
      results: 'hidden',
      revealDeadline: cs.reveal_deadline_at,
      commitCount: commit_count,
      revealedCount: revealed_count,
      hasCommitted,
      hasRevealed,
    };
  }

  // Resolved: show full results
  const { rows: votes } = await pool.query(
    `SELECT fv.account_id, fv.vote_value, fv.reason_tag, fv.weight, fv.revealed_at,
            a.name AS voter_name
     FROM formal_votes fv
     JOIN accounts a ON a.id = fv.account_id
     WHERE fv.changeset_id = $1 AND fv.revealed_at IS NOT NULL
     ORDER BY fv.weight DESC`,
    [changesetId]
  );

  const score = cs.vote_score;
  const decision = evaluateDecision(
    score, revealed_count,
    isSug ? Q_SUGGESTION_MIN : Q_MIN,
    isSug ? TAU_SUGGESTION_ACCEPT : TAU_ACCEPT,
    isSug ? TAU_SUGGESTION_REJECT : TAU_REJECT
  );

  return {
    phase: 'resolved',
    status: 'decided',
    score,
    decision,
    commitCount: commit_count,
    revealedCount: revealed_count,
    votes: votes.map(v => ({
      accountId: v.account_id,
      voterName: v.voter_name,
      voteValue: v.vote_value,
      reasonTag: v.reason_tag,
      weight: v.weight,
      revealedAt: v.revealed_at,
    })),
  };
}

module.exports = {
  startCommitPhase,
  commitVote,
  revealVote,
  tallyAndResolve,
  getVoteStatus,
};
