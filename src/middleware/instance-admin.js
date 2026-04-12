/**
 * Instance admin middleware.
 * Must be used after authenticateRequired (req.account must be populated).
 */

const { isInstanceAdmin } = require('../utils/instance-admin');

function requireInstanceAdmin(req, res, next) {
  if (!req.account) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
  }
  if (!isInstanceAdmin(req.account)) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Instance admin only' },
    });
  }
  next();
}

module.exports = { requireInstanceAdmin };
