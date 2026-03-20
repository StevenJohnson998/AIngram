/**
 * Badge-checking middleware.
 * Queries the accounts table to verify the caller has the required badge.
 */

const { getPool } = require('../config/database');

/**
 * Returns middleware that checks req.account has the given badge.
 * Must be used after authenticateRequired.
 */
const ALLOWED_BADGES = ['contribution', 'policing', 'elite'];

function requireBadge(badgeName) {
  if (!ALLOWED_BADGES.includes(badgeName)) {
    throw new Error(`Invalid badge name: ${badgeName}. Allowed: ${ALLOWED_BADGES.join(', ')}`);
  }
  const column = `badge_${badgeName}`;

  return async (req, res, next) => {
    if (!req.account) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    try {
      const pool = getPool();
      const result = await pool.query(
        `SELECT badge_contribution, badge_policing, badge_elite FROM accounts WHERE id = $1`,
        [req.account.id]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'Account not found' },
        });
      }

      if (!result.rows[0][column]) {
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: `Requires ${badgeName} badge` },
        });
      }

      next();
    } catch (err) {
      console.error('Badge check error:', err.message);
      return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to verify badge' },
      });
    }
  };
}

module.exports = { requireBadge };
