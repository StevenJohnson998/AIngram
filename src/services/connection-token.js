const { getPool } = require('../config/database');
const { generateToken, hashToken } = require('../utils/tokens');
const accountService = require('./account');

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_UNUSED_TOKENS = 5;

/**
 * Create a connection token linked to a specific sub-account.
 * Verifies that the sub-account belongs to the parent.
 * Returns the plaintext token (shown once in the prompt).
 */
async function createConnectionToken(accountId, subAccountId) {
  const pool = getPool();

  // Verify the sub-account belongs to the parent
  const sub = await accountService.findById(subAccountId);
  if (!sub || sub.parent_id !== accountId) {
    const err = new Error('Sub-account not found or not owned by you');
    err.code = 'FORBIDDEN';
    throw err;
  }

  // Check limit: max 5 unused, non-expired tokens per parent account
  const countResult = await pool.query(
    `SELECT COUNT(*) AS cnt FROM connection_tokens
     WHERE account_id = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [accountId]
  );
  if (parseInt(countResult.rows[0].cnt, 10) >= MAX_UNUSED_TOKENS) {
    const err = new Error('Too many active connection tokens. Wait for existing tokens to expire or be used.');
    err.code = 'RATE_LIMITED';
    throw err;
  }

  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await pool.query(
    `INSERT INTO connection_tokens (account_id, token_hash, expires_at, sub_account_id)
     VALUES ($1, $2, $3, $4)`,
    [accountId, tokenHash, expiresAt, subAccountId]
  );

  return { token, expiresAt };
}

/**
 * Redeem a connection token: validate, mark used, activate the linked sub-account.
 * Returns { account, apiKey }.
 */
async function redeemConnectionToken(token) {
  const pool = getPool();
  const tokenHash = hashToken(token);

  // Find valid token
  const result = await pool.query(
    `UPDATE connection_tokens
     SET used_at = NOW()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING id, account_id, sub_account_id`,
    [tokenHash]
  );

  if (result.rows.length === 0) {
    const err = new Error('Invalid, expired, or already used connection token');
    err.code = 'INVALID_TOKEN';
    throw err;
  }

  const subAccountId = result.rows[0].sub_account_id;

  // Activate the pre-created sub-account (generates API key, sets status active)
  const { account, apiKey } = await accountService.activateSubAccount(subAccountId);

  return { account, apiKey };
}

module.exports = { createConnectionToken, redeemConnectionToken };
