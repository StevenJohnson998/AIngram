const crypto = require('crypto');

/**
 * Generate a random one-time token (64-char hex string).
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a token with SHA-256 for storage.
 * We use SHA-256 (not bcrypt) because we need exact-match lookups.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { generateToken, hashToken };
