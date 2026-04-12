'use strict';

const { Router } = require('express');
const topicAgorai = require('../services/topic-agorai');
const { getPool } = require('../config/database');
const { analyzeUserInput } = require('../services/injection-detector');
const injectionTracker = require('../services/injection-tracker');

const auth = require('../middleware/auth');
const { authenticatedLimiter, publicLimiter } = require('../middleware/rate-limit');

const router = Router();

/**
 * GET /topics/:id/discussion
 * Public — reads discussion messages from Agorai.
 */
router.get('/topics/:id/discussion', publicLimiter, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const result = await topicAgorai.getDiscussion(req.params.id, { limit, offset });
  res.json(result);
});

/**
 * POST /topics/:id/discussion
 * Auth required — posts a message to the topic's Agorai conversation.
 */
router.post('/topics/:id/discussion', auth.authenticateRequired, authenticatedLimiter, async (req, res) => {
  const { content, level } = req.body || {};

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'content is required and must be a non-empty string' },
    });
  }

  if (content.length > 10000) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'content must not exceed 10000 characters' },
    });
  }

  // Check if account is blocked from discussion
  if (await injectionTracker.isBlocked(req.account.id)) {
    return res.status(422).json({
      error: { code: 'DISCUSSION_BLOCKED', message: 'Your discussion privileges are suspended pending review.' },
    });
  }

  // Analyze for injection and track cumulative score
  const detection = analyzeUserInput(content, 'discussion.content', {
    topicId: req.params.id,
    accountId: req.account.id,
  });
  const tracking = await injectionTracker.recordDetection(
    req.account.id, detection, 'discussion.content', content.substring(0, 200)
  );
  if (tracking.blocked) {
    return res.status(422).json({
      error: { code: 'DISCUSSION_BLOCKED', message: 'Your discussion privileges are suspended pending review.' },
    });
  }

  const message = await topicAgorai.postToDiscussion(req.params.id, {
    content: content.trim(),
    accountId: req.account.id,
    accountName: req.account.name || req.account.id,
    level: level || 1,
  });

  if (!message) {
    return res.status(503).json({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Discussion service is currently unavailable' },
    });
  }

  // Track participation for deliberation bonus (fire-and-forget)
  const pool = getPool();
  pool.query(
    `INSERT INTO activity_log (account_id, action, target_type, target_id)
     VALUES ($1, 'discussion_post', 'topic', $2)`,
    [req.account.id, req.params.id]
  ).catch(() => {}); // silent

  res.status(201).json(message);
});

module.exports = router;
