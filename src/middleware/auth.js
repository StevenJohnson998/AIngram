const jwt = require('jsonwebtoken');
const { getPool } = require('../config/database');

const JWT_SECRET = () => process.env.JWT_SECRET;

/**
 * Authenticate via Bearer API key or JWT cookie.
 * Sets req.account = { id, type, status } on success.
 */
async function authenticateRequired(req, res, next) {
  try {
    const account = await extractAccount(req);
    if (!account) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    if (account.status === 'banned') {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    // Root accounts (human and AI) must confirm email
    if (!account.parent_id && account.email_confirmed === false) {
      return res.status(403).json({
        error: { code: 'EMAIL_NOT_CONFIRMED', message: 'Please confirm your email before using the API. Check your inbox or resend: POST /v1/accounts/resend-confirmation' },
      });
    }

    req.account = { id: account.id, name: account.name, type: account.type, status: account.status, lang: account.lang || 'en', parentId: account.parent_id || null, tier: account.tier || 0, badgeContribution: !!account.badge_contribution, badgePolicing: !!account.badge_policing, badgeElite: !!account.badge_elite, reputationCopyright: account.reputation_copyright ?? 0.5 };
    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
  }
}

/**
 * Same as authenticateRequired but passes through if no auth provided.
 */
async function authenticateOptional(req, _res, next) {
  try {
    const account = await extractAccount(req);
    if (account && account.status !== 'banned') {
      req.account = { id: account.id, name: account.name, type: account.type, status: account.status, lang: account.lang || 'en', parentId: account.parent_id || null, tier: account.tier || 0, badgeContribution: !!account.badge_contribution, badgePolicing: !!account.badge_policing, badgeElite: !!account.badge_elite, reputationCopyright: account.reputation_copyright ?? 0.5 };
    }
  } catch (err) {
    console.warn('Optional auth failed:', err.message);
  }
  next();
}

/**
 * Returns middleware that checks req.account.status is in allowed statuses.
 */
function requireStatus(...statuses) {
  return (req, res, next) => {
    if (!req.account) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }
    if (!statuses.includes(req.account.status)) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
      });
    }
    next();
  };
}

/**
 * Extract account from Bearer token (API key) or JWT cookie.
 * Supports new-format keys (aingram_<prefix>_<secret>) with prefix lookup,
 * and legacy keys (raw hex) with X-Account-Email header (deprecated).
 * Returns account row or null.
 */
async function extractAccount(req) {
  const bcrypt = require('bcryptjs');
  const { parseApiKey, findByApiKeyPrefix } = require('../services/account');

  // Try Bearer token first
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    // Try new-format key: aingram_<prefix>_<secret>
    const parsed = parseApiKey(token);
    if (parsed) {
      const account = await findByApiKeyPrefix(parsed.prefix);
      if (!account || !account.api_key_hash) return null;

      const valid = await bcrypt.compare(parsed.secret, account.api_key_hash);
      if (!valid) return null;

      return account;
    }

    // Legacy fallback: raw key + X-Account-Email header (deprecated)
    const email = req.headers['x-account-email'];
    if (!email) return null;

    console.warn('[DEPRECATION] API key auth via X-Account-Email is deprecated. Use new-format keys (aingram_<prefix>_<secret>).');

    const pool = getPool();
    const result = await pool.query(
      'SELECT id, name, type, status, lang, api_key_hash, parent_id, tier, badge_contribution, badge_policing, badge_elite, reputation_copyright FROM accounts WHERE owner_email = $1',
      [email]
    );
    if (result.rows.length === 0) return null;

    const account = result.rows[0];
    if (!account.api_key_hash) return null;

    const valid = await bcrypt.compare(token, account.api_key_hash);
    if (!valid) return null;

    return account;
  }

  // Try JWT cookie
  const token = req.cookies && req.cookies.aingram_token;
  if (token) {
    const payload = jwt.verify(token, JWT_SECRET());
    const pool = getPool();
    const result = await pool.query(
      'SELECT id, name, type, status, lang, parent_id, email_confirmed, tier, badge_contribution, badge_policing, badge_elite FROM accounts WHERE id = $1',
      [payload.sub]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
  }

  return null;
}

module.exports = { authenticateRequired, authenticateOptional, requireStatus, extractAccount };
