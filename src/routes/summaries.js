/**
 * Summary chunk routes -- article + discussion summaries for topics.
 * Summary chunks are chunk_type='summary'. At most 1 published per topic (auto-supersession).
 */

const { Router } = require('express');
const chunkService = require('../services/chunk');
const auth = require('../middleware/auth');
const { authenticatedLimiter } = require('../middleware/rate-limit');
const { validationError, notFoundError } = require('../utils/http-errors');

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /topics/:topicId/summary -- propose a summary chunk
router.post(
  '/topics/:topicId/summary',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active'),
  async (req, res) => {
    try {
      const { topicId } = req.params;
      if (!UUID_RE.test(topicId)) return validationError(res, 'Invalid topic ID');

      const { articleSummary, discussionSummary } = req.body;

      if (!articleSummary && !discussionSummary) {
        return validationError(res, 'At least one of articleSummary or discussionSummary is required');
      }
      if (articleSummary && (typeof articleSummary !== 'string' || articleSummary.length > 5000)) {
        return validationError(res, 'articleSummary must be a string (max 5000 chars)');
      }
      if (discussionSummary && (typeof discussionSummary !== 'string' || discussionSummary.length > 5000)) {
        return validationError(res, 'discussionSummary must be a string (max 5000 chars)');
      }

      const chunk = await chunkService.createSummaryChunk({
        topicId,
        createdBy: req.account.id,
        articleSummary: articleSummary || null,
        discussionSummary: discussionSummary || null,
      });

      return res.status(201).json({ data: chunk });
    } catch (err) {
      if (err.code === 'NOT_FOUND') return notFoundError(res, err.message);
      if (err.code === 'VALIDATION_ERROR') return validationError(res, err.message);
      console.error('Error creating summary chunk:', err.message);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create summary' } });
    }
  }
);

// GET /topics/:topicId/summary -- get active summary for a topic
router.get(
  '/topics/:topicId/summary',
  async (req, res) => {
    try {
      const { topicId } = req.params;
      if (!UUID_RE.test(topicId)) return validationError(res, 'Invalid topic ID');

      const summary = await chunkService.getActiveSummary(topicId);
      if (!summary) {
        return res.json({ data: null });
      }

      return res.json({
        data: {
          id: summary.id,
          articleSummary: summary.article_summary,
          discussionSummary: summary.discussion_summary,
          trustScore: summary.trust_score,
          createdBy: summary.created_by,
          createdAt: summary.created_at,
          updatedAt: summary.updated_at,
        },
      });
    } catch (err) {
      console.error('Error fetching summary:', err.message);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch summary' } });
    }
  }
);

module.exports = router;
