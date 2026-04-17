/**
 * Sanction service — escalation, lifecycle, and enforcement.
 */

const { getPool } = require('../config/database');
const flagService = require('./flag');
const { recalculateChunkTrust } = require('./reputation');
const { analyzeUserInput } = require('./injection-detector');

// Hook for MCP session eviction on ban/suspend. Set by MCP mount at startup.
let _onAccountBlocked = null;
function onAccountBlocked(fn) { _onAccountBlocked = fn; }

/**
 * Escalation rules: determine sanction type based on prior active minor sanctions.
 */
const { determineSanctionType } = require('../domain');

/**
 * Create a sanction with automatic escalation.
 */
async function createSanction({ accountId, severity, reason, issuedBy }) {
  // S4: defensive injection telemetry on sanction reason
  if (reason) analyzeUserInput(reason, 'sanction.reason', { accountId, issuedBy, severity });

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

      // Nullify votes INSIDE the transaction (atomic with ban)
      const { rows: bannedRows } = await client.query(
        `SELECT id FROM accounts WHERE status = 'banned'
         AND (
           id = $1
           OR id = (SELECT parent_id FROM accounts WHERE id = $1)
           OR parent_id = (SELECT COALESCE(parent_id, id) FROM accounts WHERE id = $1)
         )`,
        [accountId]
      );
      const bannedIds = bannedRows.map((r) => r.id);
      await nullifyVotesOnBan(bannedIds, client);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Evict from active MCP sessions immediately
  if (sanction.type === 'ban' || sanction.type === 'account_freeze') {
    try { _onAccountBlocked?.(accountId); } catch {}
  }

  // Post-ban audit runs OUTSIDE the transaction (non-critical, fire-and-forget)
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
 * Soft-nullify all votes by a banned account (set weight=0).
 * Then recalculate trust_score for all affected chunks.
 * For cascade bans, pass all banned account IDs.
 */
async function nullifyVotesOnBan(accountIds, queryable) {
  const db = queryable || getPool();
  const ids = Array.isArray(accountIds) ? accountIds : [accountIds];

  // Nullify informal votes
  const voteResult = await db.query(
    `UPDATE votes SET weight = 0
     WHERE account_id = ANY($1) AND weight != 0
     RETURNING target_type, target_id`,
    [ids]
  );

  // Nullify formal votes
  const formalResult = await db.query(
    `UPDATE formal_votes SET weight = 0
     WHERE account_id = ANY($1) AND weight != 0
     RETURNING chunk_id`,
    [ids]
  );

  // Collect unique chunk IDs that need trust recalculation
  const chunkIds = new Set();
  for (const row of voteResult.rows) {
    if (row.target_type === 'chunk') chunkIds.add(row.target_id);
  }
  for (const row of formalResult.rows) {
    chunkIds.add(row.chunk_id);
  }

  // Fire-and-forget recalculation for each affected chunk
  for (const chunkId of chunkIds) {
    recalculateChunkTrust(chunkId).catch((err) => {
      console.error(`Chunk trust recalc after ban failed for ${chunkId}:`, err.message);
    });
  }

  return {
    votesNullified: voteResult.rowCount,
    formalVotesNullified: formalResult.rowCount,
    chunksRecalculated: chunkIds.size,
  };
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
  determineSanctionType,
  createSanction,
  liftSanction,
  getActiveSanctions,
  getSanctionHistory,
  listAllActive,
  isVoteSuspended,
  postBanAudit,
  nullifyVotesOnBan,
  onAccountBlocked,
};
