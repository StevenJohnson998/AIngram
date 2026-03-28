/**
 * Sanction routes — create, lift, list sanctions.
 */

const { Router } = require('express');
const sanctionService = require('../services/sanction');

const auth = require('../middleware/auth');
const { authenticatedLimiter } = require('../middleware/rate-limit');

const { requireBadge } = require('../middleware/badge');

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_SEVERITIES = ['minor', 'grave'];

function validationError(res, message) {
  return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message } });
}

function parsePagination(query) {
  let page = parseInt(query.page, 10) || 1;
  let limit = parseInt(query.limit, 10) || 20;
  if (page < 1) page = 1;
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;
  return { page, limit };
}

// GET /accounts/:id/sanctions — public sanction history
router.get(
  '/accounts/:id/sanctions',
  auth.authenticateOptional,
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Invalid account ID');
      }

      const { page, limit } = parsePagination(req.query);
      const result = await sanctionService.getSanctionHistory(req.params.id, { page, limit });
      return res.json(result);
    } catch (err) {
      console.error('Error getting sanction history:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get sanction history' } });
    }
  }
);

// POST /sanctions — create sanction (policing badge required)
router.post(
  '/sanctions',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active'),
  requireBadge('policing'),
  async (req, res) => {
    try {
      const { accountId, severity, reason } = req.body;

      if (!accountId || typeof accountId !== 'string' || !UUID_RE.test(accountId)) {
        return validationError(res, 'accountId must be a valid UUID');
      }
      if (!severity || !VALID_SEVERITIES.includes(severity)) {
        return validationError(res, `severity must be one of: ${VALID_SEVERITIES.join(', ')}`);
      }
      if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
        return validationError(res, 'reason is required');
      }

      const sanction = await sanctionService.createSanction({
        accountId,
        severity,
        reason: reason.trim(),
        issuedBy: req.account.id,
      });

      return res.status(201).json(sanction);
    } catch (err) {
      console.error('Error creating sanction:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create sanction' } });
    }
  }
);

// PUT /sanctions/:id/lift — lift sanction (policing badge required)
router.put(
  '/sanctions/:id/lift',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active'),
  requireBadge('policing'),
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Invalid sanction ID');
      }

      const sanction = await sanctionService.liftSanction(req.params.id);
      return res.json(sanction);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      }
      console.error('Error lifting sanction:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to lift sanction' } });
    }
  }
);

// GET /sanctions/active — list all active sanctions (policing badge required)
router.get(
  '/sanctions/active',
  auth.authenticateRequired,
  auth.requireStatus('active'),
  requireBadge('policing'),
  async (req, res) => {
    try {
      const { page, limit } = parsePagination(req.query);
      const result = await sanctionService.listAllActive({ page, limit });
      return res.json(result);
    } catch (err) {
      console.error('Error listing active sanctions:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list active sanctions' } });
    }
  }
);

module.exports = router;
