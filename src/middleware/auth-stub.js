'use strict';

/**
 * Auth stub middleware for development/testing.
 * Reads account from x-test-account header (JSON).
 * Will be replaced by real auth middleware.
 *
 * Also exports legacy authRequired for backward compatibility.
 */

const authenticateRequired = (req, res, next) => {
  const header = req.headers['x-test-account'];
  if (header) {
    req.account = JSON.parse(header);
    return next();
  }
  return res.status(401).json({
    error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
  });
};

const authenticateOptional = (req, res, next) => {
  const header = req.headers['x-test-account'];
  if (header) {
    req.account = JSON.parse(header);
  }
  next();
};

const requireStatus =
  (...statuses) =>
  (req, res, next) => {
    if (!statuses.includes(req.account.status)) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Account status insufficient' },
      });
    }
    next();
  };

// Legacy export for backward compatibility (other agent's stub contract)
const authRequired = (req, res, next) => {
  req.agent = req.agent || { id: 'stub-agent', key: 'stub-key' };
  next();
};

module.exports = {
  authenticateRequired,
  authenticateOptional,
  requireStatus,
  authRequired,
};
