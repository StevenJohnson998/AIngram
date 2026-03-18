/**
 * Sanction service — escalation, lifecycle, and enforcement.
 */

const { getPool } = require('../config/database');
const flagService = require('./flag');

/**
 * Escalation rules: determine sanction type based on prior active minor sanctions.
 */
const ESCALATION_RULES = [
  { priorCount: 0, type: 'vote_suspension' },
  { priorCount: 1, type: 'rate_limit' },
  // 2+ -> account_freeze
];

/**
 * Determine sanction type based on severity and prior sanctions.
 */
function determineSanctionType(severity, priorActiveMinorCount) {
  if (severity === 'grave') return 'ban';
  if (priorActiveMinorCount >= 2) return 'account_freeze';
  if (priorActiveMinorCount === 1) return 'rate_limit';
  return 'vote_suspension';
}

/**
 * Create a sanction with automatic escalation.
 */
async function createSanction({ accountId, severity, reason, issuedBy }) {
  const pool = getPool();

  // Count prior active minor sanctions
  const priorResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM sanctions
     WHERE account_id = $1 AND active = true AND severity = 'minor'`,
    [accountId]
  );
  const priorCount = priorResult.rows[0].count;

  const type = determineSanctionType(severity, priorCount);

  // Insert sanction
  const result = await pool.query(
    `INSERT INTO sanctions (account_id, severity, type, reason, issued_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [accountId, severity, type, reason, issuedBy]
  );
  const sanction = result.rows[0];

  // Update account status based on sanction type
  if (type === 'account_freeze') {
    await pool.query(
      "UPDATE accounts SET status = 'suspended' WHERE id = $1",
      [accountId]
    );
  } else if (type === 'ban') {
    await pool.query(
      "UPDATE accounts SET status = 'banned' WHERE id = $1",
      [accountId]
    );
    // Trigger post-ban audit asynchronously (don't block response)
    postBanAudit(accountId, issuedBy).catch((err) => {
      console.error('Post-ban audit error:', err.message);
    });
  }

  return sanction;
}

/**
 * Lift a sanction, set probation period.
 */
async function liftSanction(sanctionId) {
  const pool = getPool();

  const result = await pool.query(
    `UPDATE sanctions SET active = false, lifted_at = now()
     WHERE id = $1 AND active = true
     RETURNING *`,
    [sanctionId]
  );
  if (result.rows.length === 0) {
    const err = new Error('Sanction not found or already lifted');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const sanction = result.rows[0];

  // Set probation and restore status if suspended
  await pool.query(
    `UPDATE accounts SET
       probation_until = now() + interval '30 days',
       status = CASE WHEN status = 'suspended' THEN 'active' ELSE status END
     WHERE id = $1`,
    [sanction.account_id]
  );

  return sanction;
}

/**
 * Get active sanctions for an account.
 */
async function getActiveSanctions(accountId) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM sanctions WHERE account_id = $1 AND active = true
     ORDER BY issued_at DESC`,
    [accountId]
  );
  return result.rows;
}

/**
 * Get sanction history for an account, paginated.
 */
async function getSanctionHistory(accountId, { page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const countResult = await pool.query(
    'SELECT COUNT(*)::int AS total FROM sanctions WHERE account_id = $1',
    [accountId]
  );
  const total = countResult.rows[0].total;

  const dataResult = await pool.query(
    `SELECT * FROM sanctions WHERE account_id = $1
     ORDER BY issued_at DESC LIMIT $2 OFFSET $3`,
    [accountId, limit, offset]
  );

  return {
    data: dataResult.rows,
    pagination: { page, limit, total },
  };
}

/**
 * List all active sanctions (admin view), paginated.
 */
async function listAllActive({ page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const countResult = await pool.query(
    'SELECT COUNT(*)::int AS total FROM sanctions WHERE active = true'
  );
  const total = countResult.rows[0].total;

  const dataResult = await pool.query(
    `SELECT * FROM sanctions WHERE active = true
     ORDER BY issued_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return {
    data: dataResult.rows,
    pagination: { page, limit, total },
  };
}

/**
 * Check if an account has an active vote suspension.
 */
async function isVoteSuspended(accountId) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM sanctions
     WHERE account_id = $1 AND active = true AND type = 'vote_suspension'`,
    [accountId]
  );
  return result.rows[0].count > 0;
}

/**
 * Post-ban audit: flag all contributions by the banned account.
 * Uses INSERT...SELECT for bulk flag creation instead of N individual inserts.
 * @param {string} accountId - The banned account
 * @param {string} [issuedBy] - The admin/moderator who issued the ban (used as reporter)
 */
async function postBanAudit(accountId, issuedBy) {
  const pool = getPool();
  const reporterId = issuedBy || accountId;
  const reason = 'Post-ban audit: reviewing contributions of banned account';

  // Bulk-flag all messages by this account
  const msgResult = await pool.query(
    `INSERT INTO flags (reporter_id, target_type, target_id, reason, detection_type)
     SELECT $1, 'message', id, $2, 'manual'
     FROM messages WHERE account_id = $3`,
    [reporterId, reason, accountId]
  );

  // Bulk-flag all chunks by this account
  const chunkResult = await pool.query(
    `INSERT INTO flags (reporter_id, target_type, target_id, reason, detection_type)
     SELECT $1, 'chunk', id, $2, 'manual'
     FROM chunks WHERE created_by = $3`,
    [reporterId, reason, accountId]
  );

  return { messagesFlag: msgResult.rowCount, chunksFlag: chunkResult.rowCount };
}

module.exports = {
  ESCALATION_RULES,
  determineSanctionType,
  createSanction,
  liftSanction,
  getActiveSanctions,
  getSanctionHistory,
  listAllActive,
  isVoteSuspended,
  postBanAudit,
};
