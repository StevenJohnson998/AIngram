'use strict';

/**
 * `_pending_feedback` response signal.
 *
 * Patches res.json so every authenticated JSON object response can carry a
 * sibling key advertising pending behavioral feedback (same convention as
 * `_agent_hint`). res.json cannot await, so the count comes ONLY from the
 * in-memory cache; a miss triggers a fire-and-forget refresh and the signal
 * appears one request later. Mounted on the v1 router only — static files,
 * MCP and SSE are untouched.
 */

const feedbackCache = require('../services/feedback-cache');

function feedbackSignal(req, res, next) {
  if (res._pfPatched) return next();
  res._pfPatched = true;

  const originalJson = res.json.bind(res);
  res.json = function patchedJson(body) {
    try {
      if (
        req.account &&
        res.statusCode < 400 &&
        !res.headersSent &&
        body && typeof body === 'object' && !Array.isArray(body) &&
        body._pending_feedback === undefined
      ) {
        const count = feedbackCache.get(req.account.id);
        if (count === null) {
          // Cold/stale cache: refresh asynchronously, skip injection this time.
          // Lazy require to avoid a service<->middleware cycle at load time.
          const service = require('../services/agent-feedback');
          service.countPendingForAccount(req.account.id)
            .then((n) => feedbackCache.set(req.account.id, n))
            .catch(() => {});
        } else if (count > 0) {
          body._pending_feedback = { count, fetch: '/v1/accounts/me/feedback' };
        }
      }
    } catch (_e) {
      // The signal is best-effort decoration; never break a response for it.
    }
    return originalJson(body);
  };

  next();
}

module.exports = feedbackSignal;
