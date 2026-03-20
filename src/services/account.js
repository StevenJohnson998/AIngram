const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getPool } = require('../config/database');
const { generateToken, hashToken } = require('../utils/tokens');
const emailService = require('./email');

const BCRYPT_PASSWORD_ROUNDS = 12;
const BCRYPT_APIKEY_ROUNDS = 10;

/**
 * Generate a new-format API key: aingram_<8hex>_<24hex>
 * Returns { fullKey, prefix, secret }
 */
function generateApiKey() {
  const prefix = crypto.randomBytes(4).toString('hex');   // 8 hex chars
  const secret = crypto.randomBytes(12).toString('hex');  // 24 hex chars
  const fullKey = `aingram_${prefix}_${secret}`;
  return { fullKey, prefix, secret };
}

/**
 * Parse a Bearer token into { prefix, secret } if it matches new format.
 * Returns null if the token doesn't match aingram_<prefix>_<secret>.
 */
function parseApiKey(bearerToken) {
  if (!bearerToken) return null;
  const match = bearerToken.match(/^aingram_([0-9a-f]{8})_([0-9a-f]{24})$/);
  if (!match) return null;
  return { prefix: match[1], secret: match[2] };
}

/**
 * Create a new account with hashed password and API key.
 * Returns { account, apiKey } where apiKey is the plaintext key (shown once).
 */
async function createAccount({ name, type, ownerEmail, password }) {
  const pool = getPool();

  // Check for existing root account with same email
  const existing = await pool.query(
    'SELECT id FROM accounts WHERE owner_email = $1 AND parent_id IS NULL',
    [ownerEmail]
  );
  if (existing.rows.length > 0) {
    const err = new Error('An account with this email already exists');
    err.code = 'CONFLICT';
    throw err;
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, BCRYPT_PASSWORD_ROUNDS);

  // Generate API key (new prefix format)
  const { fullKey, prefix, secret } = generateApiKey();
  const apiKeyHash = await bcrypt.hash(secret, BCRYPT_APIKEY_ROUNDS);
  const apiKeyLast4 = fullKey.slice(-4);

  // Set provisional expiry (30 days)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  // Generate email confirmation token
  const confirmToken = generateToken();
  const confirmTokenHash = hashToken(confirmToken);
  const confirmTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  const result = await pool.query(
    `INSERT INTO accounts (name, type, owner_email, password_hash, api_key_hash, api_key_prefix, api_key_last4, account_expires_at, email_confirm_token_hash, email_confirm_token_expires)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, name, type, owner_email, status, api_key_last4, email_confirmed, created_at`,
    [name, type, ownerEmail, passwordHash, apiKeyHash, prefix, apiKeyLast4, expiresAt, confirmTokenHash, confirmTokenExpires]
  );

  // Send confirmation email (fire-and-forget)
  emailService.sendConfirmationEmail(result.rows[0], confirmToken);

  return { account: result.rows[0], apiKey: fullKey };
}

/**
 * Find account by email.
 */
async function findByEmail(email) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, name, type, owner_email, avatar_url, lang, api_key_hash, api_key_last4,
            password_hash, email_confirmed, status,
            reputation_contribution, reputation_policing,
            badge_contribution, badge_policing, badge_elite,
            probation_until, account_expires_at, first_contribution_at,
            parent_id, autonomous, created_at, last_active_at
     FROM accounts WHERE owner_email = $1 AND parent_id IS NULL`,
    [email]
  );
  return result.rows[0] || null;
}

/**
 * Find account by ID.
 */
async function findById(id) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, name, type, owner_email, avatar_url, lang, api_key_hash, api_key_last4,
            password_hash, email_confirmed, status,
            reputation_contribution, reputation_policing,
            badge_contribution, badge_policing, badge_elite,
            probation_until, account_expires_at, first_contribution_at,
            parent_id, autonomous, created_at, last_active_at
     FROM accounts WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Verify password against stored hash.
 */
async function verifyPassword(account, password) {
  if (!account.password_hash) return false;
  return bcrypt.compare(password, account.password_hash);
}

/**
 * Verify API key secret against stored hash.
 * Can accept either: (account, secret) for new-format keys, or (account, fullKey) for legacy.
 */
async function verifyApiKey(account, secret) {
  if (!account.api_key_hash) return false;
  return bcrypt.compare(secret, account.api_key_hash);
}

/**
 * Find account by API key prefix (new-format keys).
 * Returns account row or null.
 */
async function findByApiKeyPrefix(prefix) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, name, type, owner_email, avatar_url, lang, api_key_hash, api_key_prefix, api_key_last4,
            password_hash, email_confirmed, status,
            reputation_contribution, reputation_policing,
            badge_contribution, badge_policing, badge_elite,
            probation_until, account_expires_at, first_contribution_at,
            parent_id, autonomous, created_at, last_active_at
     FROM accounts WHERE api_key_prefix = $1`,
    [prefix]
  );
  return result.rows[0] || null;
}

/**
 * Rotate API key: generate new key, hash it, store it, return plaintext.
 */
async function rotateApiKey(accountId) {
  const pool = getPool();
  const { fullKey, prefix, secret } = generateApiKey();
  const apiKeyHash = await bcrypt.hash(secret, BCRYPT_APIKEY_ROUNDS);
  const apiKeyLast4 = fullKey.slice(-4);

  await pool.query(
    'UPDATE accounts SET api_key_hash = $1, api_key_prefix = $2, api_key_last4 = $3 WHERE id = $4',
    [apiKeyHash, prefix, apiKeyLast4, accountId]
  );

  return { apiKey: fullKey, apiKeyLast4 };
}

/**
 * Revoke API key: null out hash and last4.
 */
async function revokeApiKey(accountId) {
  const pool = getPool();
  await pool.query(
    'UPDATE accounts SET api_key_hash = NULL, api_key_prefix = NULL, api_key_last4 = NULL WHERE id = $1',
    [accountId]
  );
}

/**
 * Update profile fields (name, avatarUrl).
 */
async function updateProfile(accountId, { name, avatarUrl, lang }) {
  const pool = getPool();
  const fields = [];
  const values = [];
  let idx = 1;

  if (name !== undefined) {
    fields.push(`name = $${idx++}`);
    values.push(name);
  }
  if (avatarUrl !== undefined) {
    fields.push(`avatar_url = $${idx++}`);
    values.push(avatarUrl);
  }
  if (lang !== undefined) {
    fields.push(`lang = $${idx++}`);
    values.push(lang);
  }

  if (fields.length === 0) return null;

  values.push(accountId);
  const result = await pool.query(
    `UPDATE accounts SET ${fields.join(', ')} WHERE id = $${idx}
     RETURNING id, name, type, owner_email, avatar_url, lang, api_key_last4, email_confirmed, status, created_at`,
    values
  );
  return result.rows[0] || null;
}

/**
 * Confirm email using a one-time token.
 * Returns the updated account or null if token is invalid/expired.
 */
async function confirmEmailByToken(token) {
  const pool = getPool();
  const tokenHash = hashToken(token);

  const result = await pool.query(
    `UPDATE accounts
     SET email_confirmed = true,
         email_confirm_token_hash = NULL,
         email_confirm_token_expires = NULL
     WHERE email_confirm_token_hash = $1
       AND email_confirm_token_expires > NOW()
       AND email_confirmed = false
     RETURNING id, name, type, owner_email, status, api_key_last4, email_confirmed, created_at`,
    [tokenHash]
  );

  return result.rows[0] || null;
}

/**
 * Request a password reset. Generates a token, stores the hash, sends email.
 * Always succeeds (anti-enumeration): returns void regardless of whether email exists.
 */
async function requestPasswordReset(email) {
  const pool = getPool();

  const account = await findByEmail(email);
  if (!account) return; // Silent — don't reveal whether email exists

  const resetToken = generateToken();
  const resetTokenHash = hashToken(resetToken);
  const resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000); // 1h

  await pool.query(
    `UPDATE accounts
     SET password_reset_token_hash = $1, password_reset_token_expires = $2
     WHERE id = $3`,
    [resetTokenHash, resetTokenExpires, account.id]
  );

  // Send reset email (fire-and-forget)
  emailService.sendPasswordResetEmail(email, resetToken);
}

/**
 * Reset password using a one-time token.
 * Returns the updated account or null if token is invalid/expired.
 */
async function resetPassword(token, newPassword) {
  const pool = getPool();
  const tokenHash = hashToken(token);

  // Find the account by token hash (check not expired)
  const lookup = await pool.query(
    `SELECT id FROM accounts
     WHERE password_reset_token_hash = $1
       AND password_reset_token_expires > NOW()`,
    [tokenHash]
  );

  if (lookup.rows.length === 0) return null;

  const accountId = lookup.rows[0].id;
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_PASSWORD_ROUNDS);

  const result = await pool.query(
    `UPDATE accounts
     SET password_hash = $1,
         password_reset_token_hash = NULL,
         password_reset_token_expires = NULL
     WHERE id = $2
     RETURNING id, name, type, owner_email, status, api_key_last4, email_confirmed, created_at`,
    [passwordHash, accountId]
  );

  return result.rows[0] || null;
}

/**
 * Resend confirmation email: generate a new token and send it.
 * Silent on non-existent or already confirmed accounts (anti-enumeration).
 */
async function resendConfirmation(email) {
  const pool = getPool();

  const account = await findByEmail(email);
  if (!account || account.email_confirmed) return;

  const confirmToken = generateToken();
  const confirmTokenHash = hashToken(confirmToken);
  const confirmTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  await pool.query(
    `UPDATE accounts
     SET email_confirm_token_hash = $1, email_confirm_token_expires = $2
     WHERE id = $3`,
    [confirmTokenHash, confirmTokenExpires, account.id]
  );

  emailService.sendConfirmationEmail(account, confirmToken);
}

/**
 * Get public profile (safe fields only).
 */
async function getPublicProfile(accountId) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, name, type, avatar_url, lang,
            reputation_contribution, reputation_policing,
            badge_contribution, badge_policing,
            created_at
     FROM accounts WHERE id = $1`,
    [accountId]
  );
  return result.rows[0] || null;
}

/**
 * Format account for API response (strip sensitive fields).
 */
function toSafeAccount(account) {
  if (!account) return null;
  const {
    password_hash, api_key_hash, api_key_prefix, // eslint-disable-line no-unused-vars
    ...safe
  } = account;
  return safe;
}

/**
 * Create an agent sub-account under a parent human account.
 * No email/password needed.
 * If generateKey is true (default), generates API key and sets status 'active'.
 * If generateKey is false, sets status 'pending' with no API key.
 * Returns { account, apiKey } (apiKey is null when generateKey is false).
 */
async function createSubAccount({ name, parentId, generateKey = true, autonomous = true, providerId = null, description = null }) {
  const pool = getPool();

  // Verify parent is a root human account
  const parent = await findById(parentId);
  if (!parent) {
    const err = new Error('Parent account not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (parent.type !== 'human') {
    const err = new Error('Only human accounts can create sub-accounts');
    err.code = 'FORBIDDEN';
    throw err;
  }
  if (parent.parent_id) {
    const err = new Error('Sub-accounts cannot create sub-accounts');
    err.code = 'FORBIDDEN';
    throw err;
  }

  // Validate description length
  if (description && description.length > 2000) {
    const err = new Error('Description must be at most 2000 characters');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const RETURNING = 'RETURNING id, name, type, owner_email, status, api_key_last4, parent_id, autonomous, provider_id, description, created_at';

  if (!autonomous) {
    // Assisted agent: active immediately, no API key needed (backend acts on its behalf)
    const result = await pool.query(
      `INSERT INTO accounts (name, type, owner_email, parent_id, status, autonomous, provider_id, description)
       VALUES ($1, 'ai', $2, $3, 'active', false, $4, $5)
       ${RETURNING}`,
      [name, parent.owner_email, parentId, providerId, description]
    );

    return { account: result.rows[0], apiKey: null };
  }

  if (generateKey) {
    // Active sub-account with API key (backward compat / direct API usage)
    const { fullKey, prefix, secret } = generateApiKey();
    const apiKeyHash = await bcrypt.hash(secret, BCRYPT_APIKEY_ROUNDS);
    const apiKeyLast4 = fullKey.slice(-4);

    const result = await pool.query(
      `INSERT INTO accounts (name, type, owner_email, api_key_hash, api_key_prefix, api_key_last4, parent_id, status, autonomous, provider_id, description)
       VALUES ($1, 'ai', $2, $3, $4, $5, $6, 'active', true, $7, $8)
       ${RETURNING}`,
      [name, parent.owner_email, apiKeyHash, prefix, apiKeyLast4, parentId, providerId, description]
    );

    return { account: result.rows[0], apiKey: fullKey };
  }

  // Pending sub-account without API key (connection token flow)
  const result = await pool.query(
    `INSERT INTO accounts (name, type, owner_email, parent_id, status, autonomous, provider_id, description)
     VALUES ($1, 'ai', $2, $3, 'pending', true, $4, $5)
     ${RETURNING}`,
    [name, parent.owner_email, parentId, providerId, description]
  );

  return { account: result.rows[0], apiKey: null };
}

/**
 * Activate a pending sub-account: generate API key, set status 'active'.
 * Returns { account, apiKey }.
 */
async function activateSubAccount(subAccountId) {
  const pool = getPool();

  const sub = await findById(subAccountId);
  if (!sub) {
    const err = new Error('Sub-account not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  // Generate API key
  const { fullKey, prefix, secret } = generateApiKey();
  const apiKeyHash = await bcrypt.hash(secret, BCRYPT_APIKEY_ROUNDS);
  const apiKeyLast4 = fullKey.slice(-4);

  const result = await pool.query(
    `UPDATE accounts SET api_key_hash = $1, api_key_prefix = $2, api_key_last4 = $3, status = 'active'
     WHERE id = $4
     RETURNING id, name, type, owner_email, status, api_key_last4, parent_id, created_at`,
    [apiKeyHash, prefix, apiKeyLast4, subAccountId]
  );

  return { account: result.rows[0], apiKey: fullKey };
}

/**
 * List sub-accounts for a parent account.
 */
async function listSubAccounts(parentId) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, name, type, status, api_key_last4, autonomous, provider_id, description, created_at
     FROM accounts WHERE parent_id = $1
     ORDER BY created_at DESC`,
    [parentId]
  );
  return result.rows;
}

/**
 * Deactivate a sub-account (ban it). Only the parent can do this.
 */
async function deactivateSubAccount(subAccountId, parentId) {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE accounts SET status = 'banned'
     WHERE id = $1 AND parent_id = $2
     RETURNING id, name, status`,
    [subAccountId, parentId]
  );
  if (result.rows.length === 0) {
    const err = new Error('Sub-account not found or not owned by you');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return result.rows[0];
}

/**
 * Update a sub-account (name, providerId, description). Only the parent can do this.
 */
async function updateSubAccount(subAccountId, parentId, { name, providerId, description }) {
  const pool = getPool();
  const fields = [];
  const values = [];
  let idx = 1;

  if (name !== undefined) {
    if (!name || typeof name !== 'string' || name.length < 2 || name.length > 100) {
      const err = new Error('name must be between 2 and 100 characters');
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
    fields.push(`name = $${idx++}`);
    values.push(name);
  }

  if (providerId !== undefined) {
    // null clears the provider, a UUID sets it
    fields.push(`provider_id = $${idx++}`);
    values.push(providerId || null);
  }

  if (description !== undefined) {
    if (description && description.length > 2000) {
      const err = new Error('Description must be at most 2000 characters');
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
    fields.push(`description = $${idx++}`);
    values.push(description || null);
  }

  if (fields.length === 0) {
    const err = new Error('No fields to update');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  values.push(subAccountId, parentId);
  const result = await pool.query(
    `UPDATE accounts SET ${fields.join(', ')}
     WHERE id = $${idx++} AND parent_id = $${idx}
     RETURNING id, name, type, status, api_key_last4, autonomous, provider_id, description, created_at`,
    values
  );

  if (result.rows.length === 0) {
    const err = new Error('Sub-account not found or not owned by you');
    err.code = 'NOT_FOUND';
    throw err;
  }

  return result.rows[0];
}

/**
 * Reactivate a banned sub-account. Only the parent can do this.
 * Assisted or autonomous-with-key -> 'active', autonomous-without-key -> 'pending'.
 */
async function reactivateSubAccount(subAccountId, parentId) {
  const pool = getPool();

  // Fetch the sub-account
  const lookup = await pool.query(
    'SELECT id, status, autonomous, api_key_last4 FROM accounts WHERE id = $1 AND parent_id = $2',
    [subAccountId, parentId]
  );

  if (lookup.rows.length === 0) {
    const err = new Error('Sub-account not found or not owned by you');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const sub = lookup.rows[0];
  if (sub.status !== 'banned') {
    const err = new Error('Sub-account is not deactivated');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  // Determine new status: assisted or has key -> active, autonomous without key -> pending
  const newStatus = (sub.autonomous === false || sub.api_key_last4) ? 'active' : 'pending';

  const result = await pool.query(
    `UPDATE accounts SET status = $1
     WHERE id = $2 AND parent_id = $3
     RETURNING id, name, type, status, api_key_last4, autonomous, created_at`,
    [newStatus, subAccountId, parentId]
  );

  return result.rows[0];
}

module.exports = {
  createAccount,
  findByEmail,
  findById,
  findByApiKeyPrefix,
  verifyPassword,
  verifyApiKey,
  parseApiKey,
  rotateApiKey,
  revokeApiKey,
  updateProfile,
  confirmEmailByToken,
  requestPasswordReset,
  resetPassword,
  getPublicProfile,
  toSafeAccount,
  resendConfirmation,
  createSubAccount,
  activateSubAccount,
  listSubAccounts,
  deactivateSubAccount,
  updateSubAccount,
  reactivateSubAccount,
};
