/**
 * Vote service — cast/remove votes on messages and policing actions, vote queries.
 */

const { getPool } = require('../config/database');
const trustConfig = require('../config/trust');

const VALID_REASON_TAGS = [
  'accurate', 'inaccurate', 'relevant', 'off_topic',
  'well_sourced', 'unsourced', 'fair', 'unfair', 'sabotage',
];

const CONTENT_REASON_TAGS = [
  'accurate', 'inaccurate', 'relevant', 'off_topic',
  'well_sourced', 'unsourced', 'sabotage',
];

const POLICING_REASON_TAGS = ['fair', 'unfair', 'sabotage'];

const VALID_TARGET_TYPES = ['message', 'policing_action', 'chunk'];
const VALID_VALUES = ['up', 'down'];

const NEW_ACCOUNT_MS = trustConfig.NEW_ACCOUNT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

/**
 * Cast or update a vote (upsert).
 * Enforces: first_contribution_at must be set, account must be active,
 * reason_tag must match target_type, self-voting denied, retracted content denied.
 */
async function castVote({ accountId, targetType, targetId, value, reasonTag }) {
  const pool = getPool();

  // Get account details
  const { rows: accountRows } = await pool.query(
    'SELECT id, status, first_contribution_at, created_at FROM accounts WHERE id = $1',
    [accountId]
  );
  if (accountRows.length === 0) {
    throw Object.assign(new Error('Account not found'), { code: 'NOT_FOUND' });
  }
  const account = accountRows[0];

  // D23: Must have first contribution before voting
  if (!account.first_contribution_at) {
    throw Object.assign(
      new Error('Cannot vote before making a first contribution'),
      { code: 'VOTE_LOCKED' }
    );
  }

  // Must be active (provisional cannot vote)
  if (account.status !== 'active') {
    throw Object.assign(
      new Error('Only active accounts can vote'),
      { code: 'FORBIDDEN' }
    );
  }

  // Validate reason_tag matches target_type
  if (reasonTag) {
    const allowedTags = (targetType === 'message' || targetType === 'chunk') ? CONTENT_REASON_TAGS : POLICING_REASON_TAGS;
    if (!allowedTags.includes(reasonTag)) {
      throw Object.assign(
        new Error(`Invalid reason_tag '${reasonTag}' for target_type '${targetType}'`),
        { code: 'VALIDATION_ERROR' }
      );
    }
  }

  // Block self-voting: check if target belongs to the voter
  if (targetType === 'message') {
    const { rows: msgRows } = await pool.query(
      'SELECT account_id, status FROM messages WHERE id = $1',
      [targetId]
    );
    if (msgRows.length === 0) {
      throw Object.assign(new Error('Target message not found'), { code: 'NOT_FOUND' });
    }
    if (msgRows[0].account_id === accountId) {
      throw Object.assign(new Error('Cannot vote on own content'), { code: 'SELF_VOTE' });
    }
    // Deny voting on retracted content
    if (msgRows[0].status === 'retracted') {
      throw Object.assign(new Error('Cannot vote on retracted content'), { code: 'FORBIDDEN' });
    }
  }

  // Block self-voting and retracted content for chunks
  if (targetType === 'chunk') {
    const { rows: chunkRows } = await pool.query(
      'SELECT created_by, status FROM chunks WHERE id = $1',
      [targetId]
    );
    if (chunkRows.length === 0) {
      throw Object.assign(new Error('Target chunk not found'), { code: 'NOT_FOUND' });
    }
    if (chunkRows[0].created_by === accountId) {
      throw Object.assign(new Error('Cannot vote on own content'), { code: 'SELF_VOTE' });
    }
    if (chunkRows[0].status === 'retracted') {
      throw Object.assign(new Error('Cannot vote on retracted content'), { code: 'FORBIDDEN' });
    }
  }

  // Calculate weight: base (age dampening) * EigenTrust (voter reputation factor)
  const accountAge = Date.now() - new Date(account.created_at).getTime();
  const baseWeight = accountAge < NEW_ACCOUNT_MS ? trustConfig.VOTE_WEIGHT_NEW_ACCOUNT : trustConfig.VOTE_WEIGHT_ESTABLISHED;

  // EigenTrust: fetch voter's own reputation to amplify/dampen their vote
  const { rows: repRows } = await pool.query(
    'SELECT COALESCE(reputation_contribution, 0.5) AS rep FROM accounts WHERE id = $1',
    [accountId]
  );
  const voterRep = repRows.length > 0 ? repRows[0].rep : 0.5;
  const repFactor = trustConfig.VOTER_REP_BASE + voterRep;
  const weight = baseWeight * repFactor;

  // Upsert vote
  const { rows } = await pool.query(
    `INSERT INTO votes (account_id, target_type, target_id, value, reason_tag, weight)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (account_id, target_type, target_id)
     DO UPDATE SET value = $4, reason_tag = $5, weight = $6, created_at = now()
     RETURNING *`,
    [accountId, targetType, targetId, value, reasonTag || null, weight]
  );

  return rows[0];
}

/**
 * Remove a vote. Returns true if deleted, false if not found.
 */
async function removeVote(accountId, targetType, targetId) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    'DELETE FROM votes WHERE account_id = $1 AND target_type = $2 AND target_id = $3',
    [accountId, targetType, targetId]
  );
  return rowCount > 0;
}

/**
 * Get votes on a target, paginated.
 */
async function getVotesByTarget(targetType, targetId, { page = 1, limit = 20 } = {}) {
  const pool = getPool();

  const countResult = await pool.query(
    'SELECT COUNT(*)::int AS total FROM votes WHERE target_type = $1 AND target_id = $2',
    [targetType, targetId]
  );
  const total = countResult.rows[0].total;

  const offset = (page - 1) * limit;
  const dataResult = await pool.query(
    `SELECT * FROM votes WHERE target_type = $1 AND target_id = $2
     ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
    [targetType, targetId, limit, offset]
  );

  return {
    data: dataResult.rows,
    pagination: { page, limit, total },
  };
}

/**
 * Get votes by an account, paginated.
 */
async function getVotesByAccount(accountId, { page = 1, limit = 20 } = {}) {
  const pool = getPool();

  const countResult = await pool.query(
    'SELECT COUNT(*)::int AS total FROM votes WHERE account_id = $1',
    [accountId]
  );
  const total = countResult.rows[0].total;

  const offset = (page - 1) * limit;
  const dataResult = await pool.query(
    `SELECT * FROM votes WHERE account_id = $1
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [accountId, limit, offset]
  );

  return {
    data: dataResult.rows,
    pagination: { page, limit, total },
  };
}

/**
 * Get vote summary for a target: up/down counts, weighted sums, total.
 */
async function getVoteSummary(targetType, targetId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE value = 'up')::int AS "upCount",
       COUNT(*) FILTER (WHERE value = 'down')::int AS "downCount",
       COALESCE(SUM(weight) FILTER (WHERE value = 'up'), 0)::float AS "upWeight",
       COALESCE(SUM(weight) FILTER (WHERE value = 'down'), 0)::float AS "downWeight",
       COUNT(*)::int AS total
     FROM votes WHERE target_type = $1 AND target_id = $2`,
    [targetType, targetId]
  );
  return rows[0];
}

module.exports = {
  VALID_REASON_TAGS,
  CONTENT_REASON_TAGS,
  POLICING_REASON_TAGS,
  VALID_TARGET_TYPES,
  VALID_VALUES,
  castVote,
  removeVote,
  getVotesByTarget,
  getVotesByAccount,
  getVoteSummary,
};
