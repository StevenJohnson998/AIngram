/**
 * Suggestion routes — process improvement proposals (Sprint 7).
 * Suggestions are chunk_type='suggestion'. They reuse the formal vote system
 * but with higher thresholds, longer timers, and T2-only voting.
 */

const { Router } = require('express');
const chunkService = require('../services/chunk');
const formalVoteService = require('../services/formal-vote');
const auth = require('../middleware/auth');
const { authenticatedLimiter } = require('../middleware/rate-limit');
const { validationError } = require('../utils/http-errors');
const { SUGGESTION_CATEGORIES } = require('../../build/config/protocol');

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /suggestions — submit a new suggestion (any tier)
router.post(
  '/suggestions',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const { content, topicId, suggestionCategory, rationale, title } = req.body;

      if (!content || typeof content !== 'string' || content.trim().length < 20) {
        return validationError(res, 'content is required (minimum 20 characters)');
      }
      if (!topicId || !UUID_RE.test(topicId)) {
        return validationError(res, 'topicId must be a valid UUID');
      }
      if (!suggestionCategory || !SUGGESTION_CATEGORIES.includes(suggestionCategory)) {
        return validationError(res, `suggestionCategory must be one of: ${SUGGESTION_CATEGORIES.join(', ')}`);
      }
      if (title && title.length > 300) {
        return validationError(res, 'title must be 300 characters or fewer');
      }

      const suggestion = await chunkService.createSuggestion({
        content: content.trim(),
        topicId,
        createdBy: req.account.id,
        suggestionCategory,
        rationale: rationale?.trim() || null,
        title: title?.trim() || null,
      });

      return res.status(201).json(suggestion);
    } catch (err) {
      if (err.code === 'DUPLICATE_CONTENT') {
        return res.status(409).json({ error: { code: err.code, message: err.message } });
      }
      console.error('Error creating suggestion:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create suggestion' } });
    }
  }
);

// GET /suggestions — list suggestions (public, filterable)
router.get(
  '/suggestions',
  auth.authenticateOptional,
  async (req, res) => {
    try {
      const { status, category, page, limit } = req.query;
      const result = await chunkService.listSuggestions({
        status: status || 'proposed',
        category: category || null,
        page: parseInt(page, 10) || 1,
        limit: Math.min(parseInt(limit, 10) || 20, 100),
      });
      return res.json(result);
    } catch (err) {
      console.error('Error listing suggestions:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list suggestions' } });
    }
  }
);

// GET /suggestions/:id — get a single suggestion with vote status (public)
router.get(
  '/suggestions/:id',
  auth.authenticateOptional,
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Invalid suggestion ID');
      }

      const chunk = await chunkService.getChunkById(req.params.id);
      if (!chunk || chunk.chunk_type !== 'suggestion') {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Suggestion not found' } });
      }

      const voteStatus = await formalVoteService.getVoteStatus(req.params.id, req.account?.id);

      return res.json({ ...chunk, voteStatus });
    } catch (err) {
      console.error('Error getting suggestion:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get suggestion' } });
    }
  }
);

// DELETE /suggestions/:id — withdraw a suggestion (author only, if proposed)
router.delete(
  '/suggestions/:id',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Invalid suggestion ID');
      }

      const chunk = await chunkService.getChunkById(req.params.id);
      if (!chunk || chunk.chunk_type !== 'suggestion') {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Suggestion not found' } });
      }
      if (chunk.created_by !== req.account.id) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the author can withdraw a suggestion' } });
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
      console.error('Error withdrawing suggestion:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to withdraw suggestion' } });
    }
  }
);

// POST /suggestions/:id/escalate — escalate to formal vote (T2 only)
router.post(
  '/suggestions/:id/escalate',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return validationError(res, 'Invalid suggestion ID');
      }
      if ((req.account.tier || 0) < 2) {
        return res.status(403).json({
          error: { code: 'TIER_REQUIRED', message: 'Tier 2 required to escalate suggestions to formal vote' },
        });
      }

      const chunk = await chunkService.getChunkById(req.params.id);
      if (!chunk || chunk.chunk_type !== 'suggestion') {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Suggestion not found' } });
      }

      const escalated = await chunkService.escalateToReview(req.params.id, req.account.id);

      return res.json(escalated);
    } catch (err) {
      if (err.name === 'LifecycleError') {
        return res.status(409).json({ error: { code: 'INVALID_TRANSITION', message: err.message } });
      }
      console.error('Error escalating suggestion:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to escalate suggestion' } });
    }
  }
);

module.exports = router;
