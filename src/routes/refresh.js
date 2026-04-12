/**
 * Refresh mechanism routes — article freshness tracking.
 * Design: private/REFRESH-DESIGN.md
 */

const { Router } = require('express');
const auth = require('../middleware/auth');
const { authenticatedLimiter, publicLimiter } = require('../middleware/rate-limit');
const { requireBadge } = require('../middleware/badge');
const { validationError, notFoundError } = require('../utils/http-errors');
const { requireInstanceAdmin } = require('../middleware/instance-admin');
const refreshService = require('../services/refresh');
const refreshAnalytics = require('../services/refresh-analytics');

const router = Router();

// POST /chunks/:id/refresh-flag — flag a chunk for refresh
router.post(
  '/chunks/:id/refresh-flag',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const { reason, evidence } = req.body;

      if (!reason || typeof reason !== 'string' || reason.length < 5 || reason.length > 2000) {
        return validationError(res, 'Reason must be between 5 and 2000 characters');
      }

      const flag = await refreshService.flagChunk(
        req.params.id,
        req.account.id,
        reason,
        evidence || null
      );

      return res.status(201).json(flag);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.code === 'VALIDATION_ERROR') return validationError(res, err.message);
      console.error('Error flagging chunk for refresh:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to flag chunk' } });
    }
  }
);

// GET /topics/:id/refresh-flags — list pending flags for a topic
router.get('/topics/:id/refresh-flags', auth.authenticateOptional, publicLimiter, async (req, res) => {
  try {
    const flags = await refreshService.getTopicRefreshFlags(req.params.id);
    return res.json({ flags, count: flags.reduce((sum, g) => sum + g.flags.length, 0) });
  } catch (err) {
    console.error('Error getting refresh flags:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get flags' } });
  }
});

// POST /topics/:id/refresh — submit a refresh changeset
router.post(
  '/topics/:id/refresh',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const { operations, global_verdict } = req.body;

      if (!operations || !Array.isArray(operations)) {
        return validationError(res, 'operations array is required');
      }
      if (!global_verdict) {
        return validationError(res, 'global_verdict is required');
      }

      const result = await refreshService.submitRefresh(
        req.params.id,
        req.account.id,
        operations,
        global_verdict
      );

      return res.status(200).json(result);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.code === 'VALIDATION_ERROR') return validationError(res, err.message);
      if (err.code === 'INCOMPLETE_COVERAGE') {
        return res.status(400).json({
          error: { code: 'INCOMPLETE_COVERAGE', message: err.message },
        });
      }
      console.error('Error submitting refresh:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to submit refresh' } });
    }
  }
);

// GET /topics/refresh-queue — list topics needing refresh, sorted by urgency
router.get('/topics/refresh-queue', auth.authenticateOptional, publicLimiter, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    const topics = await refreshService.listRefreshQueue({ limit, offset });
    return res.json({ topics, count: topics.length });
  } catch (err) {
    console.error('Error listing refresh queue:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list queue' } });
  }
});

// POST /chunks/refresh-flags/:id/dismiss — dismiss a flag (policing badge required)
router.post(
  '/chunks/refresh-flags/:id/dismiss',
  auth.authenticateRequired, authenticatedLimiter,
  requireBadge('policing'),
  async (req, res) => {
    try {
      const { reason } = req.body;

      if (!reason || typeof reason !== 'string' || reason.length < 5) {
        return validationError(res, 'Reason must be at least 5 characters');
      }

      const flag = await refreshService.dismissFlag(req.params.id, req.account.id, reason);
      return res.json(flag);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      console.error('Error dismissing flag:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to dismiss flag' } });
    }
  }
);

// ── Analytics (instance admin only) ─────────────────────────────

// GET /refresh/analytics — per-agent refresh stats with gaming signals
router.get(
  '/refresh/analytics',
  auth.authenticateRequired,
  requireInstanceAdmin,
  async (_req, res) => {
    try {
      const stats = await refreshAnalytics.getAgentRefreshStats();
      const alertCount = stats.filter(a => a.alerts.length > 0).length;
      return res.json({ agents: stats, alertCount });
    } catch (err) {
      console.error('Error getting refresh analytics:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get analytics' } });
    }
  }
);

// GET /refresh/activity — recent refresh actions
router.get(
  '/refresh/activity',
  auth.authenticateRequired,
  requireInstanceAdmin,
  async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const activity = await refreshAnalytics.getRecentRefreshActivity(limit);
      return res.json({ activity, count: activity.length });
    } catch (err) {
      console.error('Error getting refresh activity:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get activity' } });
    }
  }
);

// GET /refresh/reputation/:accountId — reputation breakdown by source type
router.get(
  '/refresh/reputation/:accountId',
  auth.authenticateRequired,
  requireInstanceAdmin,
  async (req, res) => {
    try {
      const breakdown = await refreshAnalytics.getReputationBreakdown(req.params.accountId);
      return res.json(breakdown);
    } catch (err) {
      console.error('Error getting reputation breakdown:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get breakdown' } });
    }
  }
);

module.exports = router;
