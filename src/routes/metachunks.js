/**
 * Metachunk routes — ordering/structure for topics (F1).
 * Metachunks are chunk_type='meta'. They define chunk display order,
 * optional tags/languages, and course metadata for course-type topics.
 */

const { Router } = require('express');
const chunkService = require('../services/chunk');
const auth = require('../middleware/auth');
const { authenticatedLimiter } = require('../middleware/rate-limit');
const { validationError } = require('../utils/http-errors');

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /topics/:topicId/metachunk — propose a metachunk for a topic
router.post(
  '/topics/:topicId/metachunk',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const { topicId } = req.params;
      if (!UUID_RE.test(topicId)) {
        return validationError(res, 'topicId must be a valid UUID');
      }

      const { content } = req.body;
      if (!content || typeof content !== 'string') {
        return validationError(res, 'content is required and must be a JSON string');
      }

      const metachunk = await chunkService.createMetachunk({
        content,
        topicId,
        createdBy: req.account.id,
      });

      return res.status(201).json(metachunk);
    } catch (err) {
      if (err.status === 400) {
        return validationError(res, err.message);
      }
      if (err.status === 404) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      }
      console.error('Error creating metachunk:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create metachunk' } });
    }
  }
);

// GET /topics/:topicId/metachunk — get the active (published) metachunk
router.get(
  '/topics/:topicId/metachunk',
  auth.authenticateOptional,
  async (req, res) => {
    try {
      const { topicId } = req.params;
      if (!UUID_RE.test(topicId)) {
        return validationError(res, 'topicId must be a valid UUID');
      }

      const metachunk = await chunkService.getActiveMetachunk(topicId);
      if (!metachunk) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No active metachunk for this topic' } });
      }

      return res.json(metachunk);
    } catch (err) {
      console.error('Error getting metachunk:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get metachunk' } });
    }
  }
);

// DELETE /topics/:topicId/metachunk/:id — withdraw a proposed metachunk (author only)
router.delete(
  '/topics/:topicId/metachunk/:id',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Invalid metachunk ID');
      }

      const chunk = await chunkService.getChunkById(req.params.id);
      if (!chunk || chunk.chunk_type !== 'meta') {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Metachunk not found' } });
      }
      if (chunk.created_by !== req.account.id) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the author can withdraw a metachunk' } });
      }

      const retracted = await chunkService.retractChunk(req.params.id, {
        reason: 'withdrawn',
        retractedBy: req.account.id,
      });

      return res.json(retracted);
    } catch (err) {
      if (err.name === 'LifecycleError') {
        return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: err.message } });
      }
      console.error('Error withdrawing metachunk:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to withdraw metachunk' } });
    }
  }
);

module.exports = router;
