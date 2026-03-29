/**
 * Dispute routes — file and resolve disputes on active chunks.
 */

const { Router } = require('express');
const disputeService = require('../services/dispute');
const auth = require('../middleware/auth');
const { authenticatedLimiter } = require('../middleware/rate-limit');
const { validationError } = require('../utils/http-errors');

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /chunks/:id/dispute — file a dispute (T1+)
router.post(
  '/chunks/:id/dispute',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active'),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return validationError(res, 'Invalid chunk ID');

      // Tier check: T1+ can file disputes
      if ((req.account.tier || 0) < 1) {
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Tier 1+ required to file disputes. Contribute first to increase your tier.' },
        });
      }

      const { reason, reasonTag } = req.body;

      if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
        return validationError(res, 'reason is required (minimum 10 characters)');
      }
      if (!reasonTag || !disputeService.VALID_REASON_TAGS.includes(reasonTag)) {
        return validationError(res, `reasonTag must be one of: ${disputeService.VALID_REASON_TAGS.join(', ')}`);
      }

      const chunk = await disputeService.fileDispute(id, {
        disputedBy: req.account.id,
        reason: reason.trim(),
        reasonTag,
      });

      return res.status(200).json(chunk);
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') return validationError(res, err.message);
      if (err.code === 'NOT_FOUND') return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      if (err.name === 'LifecycleError') return res.status(409).json({ error: { code: 'LIFECYCLE_ERROR', message: err.message } });
      console.error('Error filing dispute:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to file dispute' } });
    }
  }
);

// POST /chunks/:id/resolve — resolve a dispute (T2+)
router.post(
  '/chunks/:id/resolve',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active'),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return validationError(res, 'Invalid chunk ID');

      // Tier check: T2+ can resolve disputes
      if ((req.account.tier || 0) < 2) {
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Tier 2+ required to resolve disputes.' },
        });
      }

      const { verdict, notes } = req.body;

      if (!verdict || !disputeService.VALID_VERDICTS.includes(verdict)) {
        return validationError(res, `verdict must be one of: ${disputeService.VALID_VERDICTS.join(', ')}`);
      }

      const chunk = await disputeService.resolveDispute(id, {
        resolvedBy: req.account.id,
        verdict,
        notes: notes || null,
      });

      return res.status(200).json(chunk);
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') return validationError(res, err.message);
      if (err.code === 'NOT_FOUND') return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      if (err.name === 'LifecycleError') return res.status(409).json({ error: { code: 'LIFECYCLE_ERROR', message: err.message } });
      console.error('Error resolving dispute:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve dispute' } });
    }
  }
);

// GET /disputes — list disputed chunks (T1+)
router.get(
  '/disputes',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const { page, limit } = req.query;
      const result = await disputeService.listDisputed({
        page: parseInt(page, 10) || 1,
        limit: Math.min(parseInt(limit, 10) || 20, 100),
      });
      return res.json(result);
    } catch (err) {
      console.error('Error listing disputes:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list disputes' } });
    }
  }
);

module.exports = router;
