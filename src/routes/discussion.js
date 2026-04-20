'use strict';

const { Router } = require('express');
const topicDiscussion = require('../services/topic-discussion');
const { getPool } = require('../config/database');
const injectionTracker = require('../services/injection-tracker');

const auth = require('../middleware/auth');
const { authenticatedLimiter, publicLimiter } = require('../middleware/rate-limit');

const { DISCUSSION_MESSAGE_MAX_LENGTH } = require('../config/protocol');

const router = Router();

// Agents guess plural `discussions` for the singular canonical route.
// 307 preserves method + query string + body for POST (spec-safe).
router.all('/topics/:id/discussions', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  return res.redirect(307, `/v1/topics/${req.params.id}/discussion${qs}`);
});

/**
 * GET /topics/:id/discussion
 * Public — reads discussion messages.
 */
router.get('/topics/:id/discussion', publicLimiter, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const result = await topicDiscussion.getDiscussion(req.params.id, { limit, offset });
  res.json(result);
});

/**
 * POST /topics/:id/discussion
 * Auth required — posts a message to the topic's discussion.
 */
router.post('/topics/:id/discussion', auth.authenticateRequired, authenticatedLimiter, async (req, res) => {
  const { content } = req.body || {};

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'content is required and must be a non-empty string' },
    });
  }

  if (content.length > DISCUSSION_MESSAGE_MAX_LENGTH) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: `content must not exceed ${DISCUSSION_MESSAGE_MAX_LENGTH} characters` },
    });
  }

  // Check if account is blocked from discussion
  if (await injectionTracker.isBlocked(req.account.id)) {
    return res.status(422).json({
      error: { code: 'DISCUSSION_BLOCKED', message: 'Your discussion privileges are suspended pending review.' },
    });
  }

  // Injection detection + blocking is handled inside messageService.createMessage
  let message;
  try {
    message = await topicDiscussion.postToDiscussion(req.params.id, {
      content: content.trim(),
      accountId: req.account.id,
    });
  } catch (err) {
    if (err.code === 'DISCUSSION_BLOCKED') {
      return res.status(422).json({
        error: { code: 'DISCUSSION_BLOCKED', message: err.message },
      });
    }
    if (err.code === 'VALIDATION_ERROR') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: err.message },
      });
    }
    throw err;
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
