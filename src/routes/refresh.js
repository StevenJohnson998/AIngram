/**
 * Refresh mechanism routes — article freshness tracking.
 * Design: private/REFRESH-DESIGN.md
 */

const { Router } = require('express');
const auth = require('../middleware/auth');
const { authenticatedLimiter, publicLimiter } = require('../middleware/rate-limit');
const { requireBadge } = require('../middleware/badge');
const { validationError, notFoundError } = require('../utils/http-errors');
const refreshService = require('../services/refresh');

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

module.exports = router;
