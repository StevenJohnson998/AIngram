'use strict';

/**
 * Shared helpers for MCP tool handlers.
 */

/**
 * Require authenticated account from session, throw if missing.
 * Async because it may re-query the DB when the session's auth state is stale
 * (e.g. user confirmed their email after the session was initialized). This
 * self-healing avoids forcing the agent to restart its MCP session.
 */
async function requireAccount(getSessionAccount, extra) {
  const sessionId = extra?.sessionId || extra?.meta?.sessionId;
  const account = sessionId ? getSessionAccount(sessionId) : null;
  if (account) return account;

  // No account in session. Surface the specific auth failure reason captured at
  // init time (banned, email_not_confirmed, invalid key) instead of a generic
  // message. Before returning the error, attempt a live DB re-check — the
  // blocker may have been lifted since the session started.
  if (sessionId && getSessionAccount.refreshAccount) {
    const refreshed = await getSessionAccount.refreshAccount(sessionId);
    if (refreshed) return refreshed;
  }

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

const { requireTier } = require('../utils/auth-helpers');

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
