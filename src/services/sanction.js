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
 * Delegates to domain/escalation.ts for the pure logic.
 */
function determineSanctionType(severity, priorActiveMinorCount) {
  // Domain function has same logic — keeping inline for now as the .js→.ts
  // require path will be wired when services are converted to TypeScript.
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
  const client = await pool.connect();

  let sanction;
  try {
    await client.query('BEGIN');

    // Count prior active minor sanctions
    const priorResult = await client.query(
      `SELECT COUNT(*)::int AS count FROM sanctions
       WHERE account_id = $1 AND active = true AND severity = 'minor'`,
      [accountId]
    );
    const priorCount = priorResult.rows[0].count;

    const type = determineSanctionType(severity, priorCount);

    // Insert sanction
    const result = await client.query(
      `INSERT INTO sanctions (account_id, severity, type, reason, issued_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [accountId, severity, type, reason, issuedBy]
    );
    sanction = result.rows[0];

    // Update account status based on sanction type
    if (type === 'account_freeze') {
      await client.query(
        "UPDATE accounts SET status = 'suspended' WHERE id = $1",
        [accountId]
      );
    } else if (type === 'ban') {
      await client.query(
        "UPDATE accounts SET status = 'banned' WHERE id = $1",
        [accountId]
      );

      // Cascade ban must run inside the transaction
      await cascadeBanIfNeeded(client, accountId, severity, issuedBy);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Post-ban audit runs OUTSIDE the transaction (fire-and-forget)
  if (sanction.type === 'ban') {
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

/**
 * Cascade ban to parent + all sub-accounts when:
 * - Grave violation on any sub-account
 * - 3+ total sanctions across all accounts in the family
 */
async function cascadeBanIfNeeded(queryable, accountId, severity, issuedBy) {
  // Find the family root (parent or self if root)
  const { rows: accountRows } = await queryable.query(
    'SELECT id, parent_id FROM accounts WHERE id = $1',
    [accountId]
  );
  if (accountRows.length === 0) return;

  const account = accountRows[0];
  const parentId = account.parent_id;

  // Only applies to sub-accounts (accounts with a parent)
  if (!parentId) return;

  let shouldCascade = false;

  if (severity === 'grave') {
    shouldCascade = true;
  } else {
    // Count total sanctions across parent + all siblings
    const { rows: countRows } = await queryable.query(
      `SELECT COUNT(*)::int AS total FROM sanctions s
       JOIN accounts a ON a.id = s.account_id
       WHERE (a.parent_id = $1 OR a.id = $1) AND s.active = true`,
      [parentId]
    );
    if (countRows[0].total >= 3) {
      shouldCascade = true;
    }
  }

  if (shouldCascade) {
    // Ban parent + all children
    await queryable.query(
      `UPDATE accounts SET status = 'banned'
       WHERE id = $1 OR parent_id = $1`,
      [parentId]
    );

    // Create sanction records for the cascade
    const reason = severity === 'grave'
      ? 'Cascade ban: grave violation by sub-account'
      : 'Cascade ban: 3+ sanctions across sub-accounts';

    await queryable.query(
      `INSERT INTO sanctions (account_id, severity, type, reason, issued_by)
       SELECT id, 'grave', 'ban', $1, $2
       FROM accounts
       WHERE (id = $3 OR parent_id = $3) AND id != $4 AND status = 'banned'`,
      [reason, issuedBy, parentId, accountId]
    );
  }
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
