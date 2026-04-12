/**
 * Flag service — report, review, and resolve flags on content/accounts.
 */

const { getPool } = require('../config/database');
const { analyzeUserInput } = require('./injection-detector');

const VALID_TARGET_TYPES = ['message', 'account', 'chunk', 'topic'];
const VALID_DETECTION_TYPES = ['manual', 'temporal_burst', 'network_cluster', 'creator_cluster', 'topic_concentration', 'injection_auto'];
const VALID_STATUSES = ['open', 'reviewing', 'dismissed', 'actioned'];

/**
 * Create a new flag.
 */
async function createFlag({ reporterId, targetType, targetId, reason, detectionType = 'manual' }) {
  if (!VALID_TARGET_TYPES.includes(targetType)) {
    const err = new Error(`Invalid target_type: ${targetType}`);
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  if (!VALID_DETECTION_TYPES.includes(detectionType)) {
    const err = new Error(`Invalid detection_type: ${detectionType}`);
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    const err = new Error('reason is required');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  // S4: defensive injection telemetry on flag reason
  analyzeUserInput(reason, 'flag.reason', { reporterId, targetType, targetId });

  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO flags (reporter_id, target_type, target_id, reason, detection_type)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [reporterId, targetType, targetId, reason.trim(), detectionType]
  );
  return result.rows[0];
}

/**
 * List flags filtered by status, paginated.
 */
async function listFlags({ status = 'open', page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const countResult = await pool.query(
    'SELECT COUNT(*)::int AS total FROM flags WHERE status = $1',
    [status]
  );
  const total = countResult.rows[0].total;

  const dataResult = await pool.query(
    `SELECT * FROM flags WHERE status = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [status, limit, offset]
  );

  return {
    data: dataResult.rows,
    pagination: { page, limit, total },
  };
}

/**
 * Mark a flag as reviewing.
 */
async function reviewFlag(flagId, reviewerId) {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE flags SET status = 'reviewing', reviewed_by = $1
     WHERE id = $2 AND status = 'open'
     RETURNING *`,
    [reviewerId, flagId]
  );
  if (result.rows.length === 0) {
    const err = new Error('Flag not found or not in open status');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return result.rows[0];
}

/**
 * Dismiss a flag.
 */
async function dismissFlag(flagId, reviewerId) {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE flags SET status = 'dismissed', reviewed_by = $1, resolved_at = now()
     WHERE id = $2 AND status IN ('open', 'reviewing')
     RETURNING *`,
    [reviewerId, flagId]
  );
  if (result.rows.length === 0) {
    const err = new Error('Flag not found or already resolved');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return result.rows[0];
}

/**
 * Action a flag (caller then creates sanction).
 */
async function actionFlag(flagId, reviewerId) {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE flags SET status = 'actioned', reviewed_by = $1, resolved_at = now()
     WHERE id = $2 AND status IN ('open', 'reviewing')
     RETURNING *`,
    [reviewerId, flagId]
  );
  if (result.rows.length === 0) {
    const err = new Error('Flag not found or already resolved');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return result.rows[0];
}

/**
 * Get all flags for a specific target.
 */
async function getFlagsByTarget(targetType, targetId) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM flags WHERE target_type = $1 AND target_id = $2
     ORDER BY created_at DESC`,
    [targetType, targetId]
  );
  return result.rows;
}

/**
 * Count open/reviewing flags where target is this account or their content.
 */
async function getActiveFlagCount(accountId) {
  const pool = getPool();

  // Count flags directly on the account
  const accountFlags = await pool.query(
    `SELECT COUNT(*)::int AS count FROM flags
     WHERE target_type = 'account' AND target_id = $1
     AND status IN ('open', 'reviewing')`,
    [accountId]
  );

  // Count flags on messages by this account
  const messageFlags = await pool.query(
    `SELECT COUNT(*)::int AS count FROM flags f
     JOIN messages m ON f.target_id = m.id AND f.target_type = 'message'
     WHERE m.account_id = $1 AND f.status IN ('open', 'reviewing')`,
    [accountId]
  );

  return accountFlags.rows[0].count + messageFlags.rows[0].count;
}

module.exports = {
  createFlag,
  listFlags,
  reviewFlag,
  dismissFlag,
  actionFlag,
  getFlagsByTarget,
  getActiveFlagCount,
  VALID_TARGET_TYPES,
  VALID_DETECTION_TYPES,
  VALID_STATUSES,
};
