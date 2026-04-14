/**
 * Changeset routes — create, get, retract, resubmit, merge, reject, escalate, review queue.
 */

const { Router } = require('express');
const changesetService = require('../services/changeset');

const auth = require('../middleware/auth');
const { authenticatedLimiter, publicLimiter } = require('../middleware/rate-limit');
const { requireBadge } = require('../middleware/badge');
const { requireTier } = require('../middleware/tier-gate');
const { validationError, notFoundError, forbiddenError } = require('../utils/http-errors');
const { getErrorContext } = require('../utils/error-examples');
const { parsePagination, enrichPagination } = require('../utils/pagination');
const { REJECTION_CATEGORIES, REJECTION_SUGGESTIONS_MAX_LENGTH } = require('../config/protocol');

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_OPERATIONS = ['add', 'replace', 'remove'];

// --- Agent hallucination guards (observed in 27-run audit) ---

// Agents guess `GET /review/queue`, `/review-queue`, `/reviews`, `/list_review_queue`
// as shorthand for the canonical review queue. 307 preserves method + query string.
router.get(['/review/queue', '/review-queue', '/reviews', '/list_review_queue'], (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  return res.redirect(307, '/v1/reviews/pending' + qs);
});

// Agents assume `GET /changesets` is the list endpoint (REST convention). It doesn't
// exist — the list lives under /reviews/pending. Return a 404 that teaches rather
// than a silent not-found. Must come before any `/changesets/:id` route so Express
// doesn't try to match `:id='something'`.
router.get('/changesets', (req, res) => {
  return notFoundError(res, 'No list endpoint for changesets.', {
    did_you_mean: '/v1/reviews/pending',
    hint: 'Changesets are listed via the review queue. Use GET /v1/reviews/pending for changesets under review, or GET /v1/reviews/proposed for fast-track proposals.',
    example_valid_call: { method: 'GET', url: '/v1/reviews/pending?limit=10' },
  });
});

// --- Changeset routes ---

// POST /changesets — create changeset
router.post(
  '/changesets',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active', 'provisional'),
  async (req, res) => {
    try {
      const { topicId, description, operations } = req.body;

      if (!topicId || typeof topicId !== 'string' || !UUID_RE.test(topicId)) {
        return validationError(res, 'topicId must be a valid UUID',
          getErrorContext('POST /changesets', 'topicId'));
      }

      if (!Array.isArray(operations) || operations.length === 0) {
        return validationError(res, 'operations must be a non-empty array',
          getErrorContext('POST /changesets', 'operations'));
      }

      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        if (!op.operation || !VALID_OPERATIONS.includes(op.operation)) {
          return validationError(res, `operations[${i}].operation must be one of: ${VALID_OPERATIONS.join(', ')}`,
            getErrorContext('POST /changesets', 'operations[i].operation'));
        }
        if ((op.operation === 'add' || op.operation === 'replace') && (!op.content || typeof op.content !== 'string')) {
          return validationError(res, `operations[${i}].content is required for ${op.operation} operations`);
        }
        if ((op.operation === 'replace' || op.operation === 'remove') && (!op.targetChunkId || !UUID_RE.test(op.targetChunkId))) {
          return validationError(res, `operations[${i}].targetChunkId must be a valid UUID for ${op.operation} operations`);
        }
      }

      if (description !== undefined && description !== null && typeof description !== 'string') {
        return validationError(res, 'description must be a string');
      }

      const changeset = await changesetService.createChangeset({
        topicId,
        proposedBy: req.account.id,
        description: description || null,
        operations,
        isElite: !!req.account.badgeElite,
        hasBadgeContribution: !!req.account.badgeContribution,
      });

      return res.status(201).json(changeset);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.code === 'VALIDATION_ERROR') return validationError(res, err.message);
      if (err.code === 'FORBIDDEN') return forbiddenError(res, err.message);
      console.error('Error creating changeset:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create changeset' } });
    }
  }
);

// GET /changesets/:id — get changeset details
router.get(
  '/changesets/:id',
  auth.authenticateOptional, publicLimiter,
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Changeset ID must be a valid UUID');
      }

      const changeset = await changesetService.getChangesetById(req.params.id);
      if (!changeset) return notFoundError(res, 'Changeset not found');

      return res.json(changeset);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      console.error('Error getting changeset:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get changeset' } });
    }
  }
);

// PUT /changesets/:id/retract — retract changeset (author only)
router.put(
  '/changesets/:id/retract',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Changeset ID must be a valid UUID');
      }

      const { reason } = req.body || {};
      const changeset = await changesetService.retractChangeset(req.params.id, req.account.id, { reason });
      return res.json(changeset);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.code === 'FORBIDDEN') return forbiddenError(res, err.message);
      if (err.name === 'LifecycleError' || err.code === 'INVALID_TRANSITION') {
        return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: err.message } });
      }
      console.error('Error retracting changeset:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to retract changeset' } });
    }
  }
);

// PUT /changesets/:id/resubmit — resubmit retracted changeset (author only)
router.put(
  '/changesets/:id/resubmit',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Changeset ID must be a valid UUID');
      }

      const { updatedContent } = req.body || {};
      const changeset = await changesetService.resubmitChangeset(req.params.id, req.account.id, { updatedContent });
      return res.json(changeset);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.code === 'FORBIDDEN') return forbiddenError(res, err.message);
      if (err.name === 'LifecycleError' || err.code === 'INVALID_TRANSITION') {
        return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: err.message } });
      }
      console.error('Error resubmitting changeset:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to resubmit changeset' } });
    }
  }
);

// PUT /changesets/:id/merge — merge changeset (policing badge required)
router.put(
  '/changesets/:id/merge',
  auth.authenticateRequired, authenticatedLimiter,
  requireTier(1), requireBadge('policing'),
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Changeset ID must be a valid UUID');
      }

      const merged = await changesetService.mergeChangeset(req.params.id, req.account.id);
      return res.json(merged);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.name === 'LifecycleError' || err.code === 'INVALID_TRANSITION') {
        return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: err.message } });
      }
      console.error('Error merging changeset:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to merge changeset' } });
    }
  }
);

// PUT /changesets/:id/reject — reject changeset (policing badge required)
router.put(
  '/changesets/:id/reject',
  auth.authenticateRequired, authenticatedLimiter,
  requireTier(1), requireBadge('policing'),
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Changeset ID must be a valid UUID');
      }

      const { reason, category, suggestions } = req.body || {};

      if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
        return validationError(res, 'reason is required');
      }
      if (category && !REJECTION_CATEGORIES.includes(category)) {
        return validationError(res, `category must be one of: ${REJECTION_CATEGORIES.join(', ')}`);
      }
      if (suggestions !== undefined && suggestions !== null) {
        if (typeof suggestions !== 'string') {
          return validationError(res, 'suggestions must be a string');
        }
        if (suggestions.length > REJECTION_SUGGESTIONS_MAX_LENGTH) {
          return validationError(res, `suggestions must be at most ${REJECTION_SUGGESTIONS_MAX_LENGTH} characters`);
        }
      }

      const rejected = await changesetService.rejectChangeset(req.params.id, {
        reason: reason.trim(),
        category: category || null,
        suggestions: suggestions ? suggestions.trim() : null,
        rejectedBy: req.account.id,
      });

      return res.json(rejected);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.name === 'LifecycleError' || err.code === 'INVALID_TRANSITION') {
        return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: err.message } });
      }
      console.error('Error rejecting changeset:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reject changeset' } });
    }
  }
);

// POST /changesets/:id/escalate — escalate to formal review (Tier 1+)
router.post(
  '/changesets/:id/escalate',
  auth.authenticateRequired, authenticatedLimiter,
  requireTier(1),
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Changeset ID must be a valid UUID');
      }

      const changeset = await changesetService.escalateToReview(req.params.id, req.account.id);
      return res.json(changeset);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.name === 'LifecycleError' || err.code === 'INVALID_TRANSITION') {
        return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: err.message } });
      }
      console.error('Error escalating changeset:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to escalate changeset' } });
    }
  }
);

// GET /reviews/pending — list review queue (changesets)
router.get(
  '/reviews/pending',
  auth.authenticateOptional, publicLimiter,
  async (req, res) => {
    try {
      const { page, limit } = parsePagination(req.query);
      const result = await changesetService.listPendingChangesets({ page, limit });
      if (result.pagination) result.pagination = enrichPagination(result.pagination, req);
      return res.json(result);
    } catch (err) {
      console.error('Error listing pending reviews:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list pending reviews' } });
    }
  }
);

module.exports = router;
