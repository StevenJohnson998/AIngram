/**
 * Formal vote service — commit-reveal voting protocol for chunk governance.
 * Sprint 3: implements Paper 3 (Deliberative Curation) formal voting.
 *
 * Flow: chunk enters under_review → startCommitPhase → voters commit hashes →
 *       commit deadline → reveal phase → voters reveal → tally → decision
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

/**
 * Start the commit phase for a chunk entering under_review.
 * Called after the OBJECT transition in escalateToReview.
 */
async function startCommitPhase(chunkId) {
  const pool = getPool();

  // Use longer timers for suggestion chunks
  const { rows: typeRows } = await pool.query(
    'SELECT chunk_type FROM chunks WHERE id = $1', [chunkId]
  );
  const isSuggestion = typeRows[0]?.chunk_type === 'suggestion';
  const commitMs = isSuggestion ? T_SUGGESTION_COMMIT_MS : T_COMMIT_MS;
  const revealMs = isSuggestion ? T_SUGGESTION_REVEAL_MS : T_REVEAL_MS;

  const commitDeadline = new Date(Date.now() + commitMs);
  const revealDeadline = new Date(commitDeadline.getTime() + revealMs);

  const { rows } = await pool.query(
    `UPDATE chunks
     SET vote_phase = 'commit',
         commit_deadline_at = $2,
         reveal_deadline_at = $3,
         updated_at = now()
     WHERE id = $1 AND status = 'under_review'
     RETURNING id, vote_phase, commit_deadline_at, reveal_deadline_at`,
    [chunkId, commitDeadline, revealDeadline]
  );

  if (rows.length === 0) {
    throw Object.assign(
      new Error('Chunk not found or not under_review'),
      { code: 'NOT_FOUND' }
    );
  }

  return rows[0];
}

/**
 * Commit a hashed vote during the commit phase.
 * Validates: chunk in commit phase, account active with contribution, not self-vote, weight >= W_MIN.
 */
async function commitVote({ accountId, chunkId, commitHash }) {
  const pool = getPool();

  // Validate chunk is in commit phase
  const { rows: chunkRows } = await pool.query(
    `SELECT id, vote_phase, commit_deadline_at, created_by, chunk_type
     FROM chunks WHERE id = $1`,
    [chunkId]
  );
  if (chunkRows.length === 0) {
    throw Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' });
  }
  const chunk = chunkRows[0];

  if (chunk.vote_phase !== 'commit') {
    throw Object.assign(
      new Error(`Cannot commit vote: chunk is in '${chunk.vote_phase || 'no vote'}' phase`),
      { code: 'INVALID_PHASE' }
    );
  }

  if (new Date() > new Date(chunk.commit_deadline_at)) {
    throw Object.assign(
      new Error('Commit phase has ended'),
      { code: 'DEADLINE_PASSED' }
    );
  }

  // Self-vote check
  if (chunk.created_by === accountId) {
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

  // Suggestion chunks require higher tier to vote
  if (chunk.chunk_type === 'suggestion') {
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
  const { rows } = await pool.query(
    `INSERT INTO formal_votes (chunk_id, account_id, commit_hash, weight)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chunk_id, account_id)
     DO UPDATE SET commit_hash = $3, weight = $4, committed_at = now(),
                   vote_value = NULL, reason_tag = NULL, salt = NULL, revealed_at = NULL
     RETURNING *`,
    [chunkId, accountId, commitHash, weight]
  );

  return rows[0];
}

/**
 * Reveal a previously committed vote during the reveal phase.
 * Validates: chunk in reveal phase, hash match, valid reason tag.
 */
async function revealVote({ accountId, chunkId, voteValue, reasonTag, salt }) {
  const pool = getPool();

  // Validate chunk is in reveal phase
  const { rows: chunkRows } = await pool.query(
    `SELECT id, vote_phase, reveal_deadline_at FROM chunks WHERE id = $1`,
    [chunkId]
  );
  if (chunkRows.length === 0) {
    throw Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' });
  }
  const chunk = chunkRows[0];

  if (chunk.vote_phase !== 'reveal') {
    throw Object.assign(
      new Error(`Cannot reveal vote: chunk is in '${chunk.vote_phase || 'no vote'}' phase`),
      { code: 'INVALID_PHASE' }
    );
  }

  if (new Date() > new Date(chunk.reveal_deadline_at)) {
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
  const { rows: voteRows } = await pool.query(
    `SELECT * FROM formal_votes WHERE chunk_id = $1 AND account_id = $2`,
    [chunkId, accountId]
  );
  if (voteRows.length === 0) {
    throw Object.assign(
      new Error('No committed vote found for this chunk'),
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
  const { rows } = await pool.query(
    `UPDATE formal_votes
     SET vote_value = $3, reason_tag = $4, salt = $5, revealed_at = now()
     WHERE chunk_id = $1 AND account_id = $2
     RETURNING *`,
    [chunkId, accountId, voteValue, reasonTag, salt]
  );

  return rows[0];
}

/**
 * Tally all revealed votes and resolve the chunk's fate.
 * Uses FOR UPDATE SKIP LOCKED to prevent concurrent tally races.
 */
async function tallyAndResolve(chunkId) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock the chunk row to prevent concurrent tally
    const { rows: chunkRows } = await client.query(
      `SELECT id, status, vote_phase, chunk_type FROM chunks
       WHERE id = $1 AND vote_phase IN ('reveal', 'commit')
       FOR UPDATE SKIP LOCKED`,
      [chunkId]
    );

    if (chunkRows.length === 0) {
      await client.query('ROLLBACK');
      return null; // Already resolved or locked by another process
    }

    // Fetch all revealed votes
    const { rows: votes } = await client.query(
      `SELECT vote_value, weight FROM formal_votes
       WHERE chunk_id = $1 AND revealed_at IS NOT NULL`,
      [chunkId]
    );

    const revealedCount = votes.length;
    const weightedVotes = votes.map(v => ({
      weight: v.weight,
      voteValue: v.vote_value,
    }));

    const score = computeVoteScore(weightedVotes);
    const isSuggestionChunk = chunkRows[0].chunk_type === 'suggestion';
    const qMin = isSuggestionChunk ? Q_SUGGESTION_MIN : Q_MIN;
    const tauAccept = isSuggestionChunk ? TAU_SUGGESTION_ACCEPT : TAU_ACCEPT;
    const tauReject = isSuggestionChunk ? TAU_SUGGESTION_REJECT : TAU_REJECT;
    const decision = evaluateDecision(score, revealedCount, qMin, tauAccept, tauReject);

    // Single UPDATE per decision branch (combined vote_phase + status transition)
    if (decision === 'accept') {
      await client.query(
        `UPDATE chunks SET vote_phase = 'resolved', vote_score = $2,
                status = 'published', merged_at = now(), updated_at = now()
         WHERE id = $1`,
        [chunkId, score]
      );
    } else if (decision === 'reject') {
      await client.query(
        `UPDATE chunks SET vote_phase = 'resolved', vote_score = $2,
                status = 'retracted', retract_reason = 'rejected',
                rejection_category = 'other',
                rejected_at = now(), updated_at = now()
         WHERE id = $1`,
        [chunkId, score]
      );
    } else {
      await client.query(
        `UPDATE chunks SET vote_phase = 'resolved', vote_score = $2, updated_at = now()
         WHERE id = $1`,
        [chunkId, score]
      );
    }

    const action = decision === 'accept' ? 'chunk_vote_accepted'
      : decision === 'reject' ? 'chunk_vote_rejected'
      : 'chunk_vote_indeterminate';
    await client.query(
      `INSERT INTO activity_log (action, target_type, target_id, metadata)
       VALUES ($1, 'chunk', $2, $3)`,
      [action, chunkId, JSON.stringify({ score, revealedCount, decision })]
    );

    await client.query('COMMIT');

    // Post-tally: award deliberation bonus (fire-and-forget)
    const reputationService = require('./reputation');
    reputationService.awardDeliberationBonus(chunkId)
      .catch(err => console.error('Deliberation bonus failed:', err.message));

    // Recalculate chunk trust score after formal vote resolution
    reputationService.recalculateChunkTrust(chunkId)
      .catch(err => console.error('Chunk trust recalc after tally failed:', err.message));

    // Suggestion approved: award reputation bonus to author
    if (isSuggestionChunk && decision === 'accept') {
      (async () => {
        try {
          const { rows: authorRows } = await pool.query(
            'SELECT created_by FROM chunks WHERE id = $1', [chunkId]
          );
          if (authorRows[0]?.created_by) {
            await pool.query(
              `UPDATE accounts SET reputation_contribution = LEAST(1.0, reputation_contribution + $2)
               WHERE id = $1`,
              [authorRows[0].created_by, DELTA_SUGGESTION_APPROVED]
            );
          }
        } catch (err) {
          console.error('Suggestion approval bonus failed:', err.message);
        }
      })();
    }

    return { chunkId, score, revealedCount, decision };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get the current vote status for a chunk.
 * Phase-aware: hides individual votes during commit/reveal phases.
 */
async function getVoteStatus(chunkId, requestingAccountId) {
  const pool = getPool();

  const { rows: chunkRows } = await pool.query(
    `SELECT id, status, vote_phase, commit_deadline_at, reveal_deadline_at, vote_score, chunk_type
     FROM chunks WHERE id = $1`,
    [chunkId]
  );

  if (chunkRows.length === 0) {
    throw Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' });
  }
  const chunk = chunkRows[0];

  if (!chunk.vote_phase) {
    return { phase: null, message: 'No formal vote active' };
  }

  // Count totals
  const { rows: countRows } = await pool.query(
    `SELECT
       COUNT(*)::int AS commit_count,
       COUNT(*) FILTER (WHERE revealed_at IS NOT NULL)::int AS revealed_count
     FROM formal_votes WHERE chunk_id = $1`,
    [chunkId]
  );
  const { commit_count, revealed_count } = countRows[0];

  // Check if requesting account has voted
  let hasCommitted = false;
  let hasRevealed = false;
  if (requestingAccountId) {
    const { rows: myVote } = await pool.query(
      `SELECT revealed_at FROM formal_votes
       WHERE chunk_id = $1 AND account_id = $2`,
      [chunkId, requestingAccountId]
    );
    if (myVote.length > 0) {
      hasCommitted = true;
      hasRevealed = !!myVote[0].revealed_at;
    }
  }

  if (chunk.vote_phase === 'commit') {
    return {
      phase: 'commit',
      status: 'voting_in_progress',
      results: 'hidden',
      commitDeadline: chunk.commit_deadline_at,
      revealDeadline: chunk.reveal_deadline_at,
      commitCount: commit_count,
      hasCommitted,
    };
  }

  if (chunk.vote_phase === 'reveal') {
    return {
      phase: 'reveal',
      status: 'voting_in_progress',
      results: 'hidden',
      revealDeadline: chunk.reveal_deadline_at,
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
     WHERE fv.chunk_id = $1 AND fv.revealed_at IS NOT NULL
     ORDER BY fv.weight DESC`,
    [chunkId]
  );

  const score = chunk.vote_score;
  const isSug = chunk.chunk_type === 'suggestion';
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
