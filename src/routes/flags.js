/**
 * Flag routes — report, review, and resolve flags.
 */

const { Router } = require('express');
const flagService = require('../services/flag');

const auth = require('../middleware/auth');
const { authenticatedLimiter } = require('../middleware/rate-limit');
const { requireBadge } = require('../middleware/badge');
const { validationError } = require('../utils/http-errors');

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /flags — create a flag (any active user)
router.post(
  '/flags',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active'),
  async (req, res) => {
    try {
      const { targetType, targetId, reason } = req.body;

      if (!targetType || !flagService.VALID_TARGET_TYPES.includes(targetType)) {
        return validationError(res, `targetType must be one of: ${flagService.VALID_TARGET_TYPES.join(', ')}`);
      }
      if (!targetId || typeof targetId !== 'string' || !UUID_RE.test(targetId)) {
        return validationError(res, 'targetId must be a valid UUID');
      }
      if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
        return validationError(res, 'reason is required');
      }

      const flag = await flagService.createFlag({
        reporterId: req.account.id,
        targetType,
        targetId,
        reason: reason.trim(),
      });

      return res.status(201).json(flag);
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') {
        return validationError(res, err.message);
      }
      console.error('Error creating flag:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create flag' } });
    }
  }
);

// GET /flags?status=open — list flags (policing badge required)
router.get(
  '/flags',
  auth.authenticateRequired,
  auth.requireStatus('active'),
  requireBadge('policing'),
  async (req, res) => {
    try {
      const status = req.query.status || 'open';
      if (!flagService.VALID_STATUSES.includes(status)) {
        return validationError(res, `status must be one of: ${flagService.VALID_STATUSES.join(', ')}`);
      }

      let page = parseInt(req.query.page, 10) || 1;
      let limit = parseInt(req.query.limit, 10) || 20;
      if (page < 1) page = 1;
      if (limit < 1) limit = 1;
      if (limit > 100) limit = 100;

      const result = await flagService.listFlags({ status, page, limit });
      return res.json(result);
    } catch (err) {
      console.error('Error listing flags:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list flags' } });
    }
  }
);

// PUT /flags/:id/review — mark as reviewing (policing badge required)
router.put(
  '/flags/:id/review',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active'),
  requireBadge('policing'),
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Invalid flag ID');
      }

      const flag = await flagService.reviewFlag(req.params.id, req.account.id);
      return res.json(flag);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      }
      console.error('Error reviewing flag:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to review flag' } });
    }
  }
);

// PUT /flags/:id/dismiss — dismiss flag (policing badge required)
router.put(
  '/flags/:id/dismiss',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active'),
  requireBadge('policing'),
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Invalid flag ID');
      }

      const flag = await flagService.dismissFlag(req.params.id, req.account.id);
      return res.json(flag);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      }
      console.error('Error dismissing flag:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to dismiss flag' } });
    }
  }
);

// PUT /flags/:id/action — action flag (policing badge required)
router.put(
  '/flags/:id/action',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active'),
  requireBadge('policing'),
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Invalid flag ID');
      }

      const flag = await flagService.actionFlag(req.params.id, req.account.id);
      return res.json(flag);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      }
      console.error('Error actioning flag:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to action flag' } });
    }
  }
);

// GET /flags/target?target_type=...&target_id=... — flags on a specific target
router.get(
  '/flags/target',
  auth.authenticateRequired, requireBadge('policing'),
  async (req, res) => {
    try {
      const { target_type, target_id } = req.query;
      if (!target_type || !['message', 'chunk', 'account'].includes(target_type)) {
        return validationError(res, 'target_type must be one of: message, chunk, account');
      }
      if (!target_id || !UUID_RE.test(target_id)) {
        return validationError(res, 'target_id must be a valid UUID');
      }
      const flags = await flagService.getFlagsByTarget(target_type, target_id);
      return res.json({ data: flags });
    } catch (err) {
      console.error('Error getting flags by target:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get flags' } });
    }
  }
);

// GET /accounts/:id/flags/count — active flag count for an account
router.get(
  '/accounts/:id/flags/count',
  auth.authenticateRequired,
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Account ID must be a valid UUID');
      }
      const count = await flagService.getActiveFlagCount(req.params.id);
      return res.json({ count });
    } catch (err) {
      console.error('Error getting flag count:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get flag count' } });
    }
  }
);

module.exports = router;
