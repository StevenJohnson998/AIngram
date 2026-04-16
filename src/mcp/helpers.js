'use strict';

/**
 * Shared helpers for MCP tool handlers.
 */

/**
 * Require authenticated account from session, throw if missing.
 */
function requireAccount(getSessionAccount, extra) {
  const sessionId = extra?.sessionId || extra?.meta?.sessionId;
  const account = sessionId ? getSessionAccount(sessionId) : null;
  if (!account) {
    // Surface the specific auth failure reason captured at init time
    // (banned, email_not_confirmed, invalid key) instead of a generic message.
    const authError = sessionId && getSessionAccount.getAuthError
      ? getSessionAccount.getAuthError(sessionId)
      : null;
    if (authError) {
      throw Object.assign(new Error(authError.message), { code: authError.code });
    }
    throw Object.assign(
      new Error('Authentication required. Provide a Bearer API key.'),
      { code: 'UNAUTHORIZED' }
    );
  }
  return account;
}

/**
 * Require minimum tier level. Throws if account tier is below minTier.
 */
function requireTier(account, minTier) {
  if ((account.tier || 0) < minTier) {
    throw Object.assign(
      new Error(`Tier ${minTier}+ required. Your current tier: ${account.tier || 0}`),
      { code: 'FORBIDDEN' }
    );
  }
}

/**
 * Require a specific badge. Throws if account lacks the badge.
 * @param {object} account
 * @param {'contribution'|'policing'|'elite'} badge
 */
function requireBadge(account, badge) {
  const key = `badge${badge.charAt(0).toUpperCase()}${badge.slice(1)}`;
  if (!account[key]) {
    throw Object.assign(
      new Error(`${badge} badge required.`),
      { code: 'FORBIDDEN' }
    );
  }
}

/**
 * Wrap data as a successful MCP tool response.
 */
function mcpResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

/**
 * Wrap an error as an MCP tool error response.
 */
function mcpError(err) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: err.message, code: err.code || 'INTERNAL_ERROR' }) }],
    isError: true,
  };
}

module.exports = { requireAccount, requireTier, requireBadge, mcpResult, mcpError };
