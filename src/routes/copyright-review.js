/**
 * Copyright review routes — copyright-specific review queue (D66).
 */

const { Router } = require('express');
const copyrightService = require('../services/copyright-review');
const auth = require('../middleware/auth');
const { authenticatedLimiter } = require('../middleware/rate-limit');
const { requireBadge } = require('../middleware/badge');
const { validationError } = require('../utils/http-errors');

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /copyright-reviews — list queue (badge: policing)
router.get(
  '/copyright-reviews',
  auth.authenticateRequired, authenticatedLimiter,
  requireBadge('policing'),
  async (req, res) => {
    try {
      const { status, page, limit } = req.query;
      const result = await copyrightService.listCopyrightReviews({
        status: status || 'pending',
        page: parseInt(page, 10) || 1,
        limit: Math.min(parseInt(limit, 10) || 20, 100),
      });
      return res.json(result);
    } catch (err) {
      console.error('Error listing copyright reviews:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list copyright reviews' } });
    }
  }
);

// POST /copyright-reviews — flag a chunk for copyright review (Tier 1+)
router.post(
  '/copyright-reviews',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      // Tier 1+ check
      if ((req.account.tier || 0) < 1) {
        return res.status(403).json({
          error: { code: 'TIER_REQUIRED', message: 'Tier 1 required to flag copyright concerns' },
        });
      }

      const { chunkId, reason } = req.body;
      if (!chunkId || !UUID_RE.test(chunkId)) {
        return validationError(res, 'chunkId must be a valid UUID');
      }
      if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
        return validationError(res, 'reason is required (minimum 10 characters)');
      }

      const review = await copyrightService.createCopyrightReview({
        chunkId,
        flaggedBy: req.account.id,
        reason: reason.trim(),
      });

      return res.status(201).json(review);
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') return validationError(res, err.message);
      if (err.code === 'NOT_FOUND') return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      if (err.code === 'DUPLICATE_REVIEW') return res.status(409).json({ error: { code: 'DUPLICATE_REVIEW', message: err.message } });
      if (err.code === 'ALREADY_CLEARED') return res.status(409).json({ error: { code: 'ALREADY_CLEARED', message: err.message } });
      if (err.code === 'REPORTER_SUSPENDED') return res.status(403).json({ error: { code: 'REPORTER_SUSPENDED', message: err.message } });
      console.error('Error creating copyright review:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create copyright review' } });
    }
  }
);

// PATCH /copyright-reviews/:id/assign — assign reviewer (badge: policing)
router.patch(
  '/copyright-reviews/:id/assign',
  auth.authenticateRequired, authenticatedLimiter,
  requireBadge('policing'),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return validationError(res, 'Invalid review ID');

      const { assignedTo } = req.body;
      if (!assignedTo || !UUID_RE.test(assignedTo)) {
        return validationError(res, 'assignedTo must be a valid account UUID');
      }

      const review = await copyrightService.assignReview(id, { assignedTo });
      return res.json(review);
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') return validationError(res, err.message);
      if (err.code === 'NOT_FOUND') return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      console.error('Error assigning copyright review:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to assign review' } });
    }
  }
);

// POST /copyright-reviews/:id/resolve — resolve with verdict (badge: policing)
router.post(
  '/copyright-reviews/:id/resolve',
  auth.authenticateRequired, authenticatedLimiter,
  requireBadge('policing'),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return validationError(res, 'Invalid review ID');

      const { verdict, verdictNotes } = req.body;
      if (!verdict || !copyrightService.VALID_VERDICTS.includes(verdict)) {
        return validationError(res, `verdict must be one of: ${copyrightService.VALID_VERDICTS.join(', ')}`);
      }

      const review = await copyrightService.resolveCopyrightReview(id, {
        verdict,
        verdictNotes: verdictNotes || null,
        resolvedBy: req.account.id,
      });

      return res.json(review);
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') return validationError(res, err.message);
      if (err.code === 'NOT_FOUND') return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      console.error('Error resolving copyright review:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve review' } });
    }
  }
);

// GET /copyright-reviews/tools/verbatim-search — search for copied content (badge: policing)
router.get(
  '/copyright-reviews/tools/verbatim-search',
  auth.authenticateRequired, authenticatedLimiter,
  requireBadge('policing'),
  async (req, res) => {
    try {
      const { text } = req.query;
      if (!text || typeof text !== 'string') {
        return validationError(res, 'text query parameter is required');
      }

      const results = await copyrightService.verbatimSearch(text.trim());
      return res.json({ data: results, total: results.length });
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') return validationError(res, err.message);
      console.error('Error in verbatim search:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Search failed' } });
    }
  }
);

// GET /copyright-reviews/tools/check-sources/:chunkId — check source citations (badge: policing)
router.get(
  '/copyright-reviews/tools/check-sources/:chunkId',
  auth.authenticateRequired, authenticatedLimiter,
  requireBadge('policing'),
  async (req, res) => {
    try {
      const { chunkId } = req.params;
      if (!UUID_RE.test(chunkId)) return validationError(res, 'Invalid chunk ID');

      const result = await copyrightService.checkSources(chunkId);
      return res.json(result);
    } catch (err) {
      console.error('Error checking sources:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Source check failed' } });
    }
  }
);

module.exports = router;
