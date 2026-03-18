'use strict';

const { Router } = require('express');
const topicAgorai = require('../services/topic-agorai');

const auth = require('../middleware/auth');

const router = Router();

/**
 * GET /topics/:id/discussion
 * Public — reads discussion messages from Agorai.
 */
router.get('/topics/:id/discussion', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const result = await topicAgorai.getDiscussion(req.params.id, { limit, offset });
  res.json(result);
});

/**
 * POST /topics/:id/discussion
 * Auth required — posts a message to the topic's Agorai conversation.
 */
router.post('/topics/:id/discussion', auth.authenticateRequired, async (req, res) => {
  const { content, level } = req.body || {};

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'content is required and must be a non-empty string' },
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

  res.status(201).json(message);
});

module.exports = router;
