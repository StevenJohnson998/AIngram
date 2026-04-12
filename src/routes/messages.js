/**
 * Message routes — CRUD for topic messages with level/type enforcement.
 */

const { Router } = require('express');
const messageService = require('../services/message');

const auth = require('../middleware/auth');
const { authenticatedLimiter } = require('../middleware/rate-limit');
const { validationError, notFoundError, forbiddenError } = require('../utils/http-errors');
const { parsePagination } = require('../utils/pagination');

const router = Router();

const VALID_VERBOSITIES = ['low', 'medium', 'high'];
const LEVEL_1_TYPES = ['contribution', 'reply', 'edit'];
const LEVEL_2_TYPES = ['flag', 'merge', 'revert', 'moderation_vote'];
const LEVEL_3_TYPES = ['coordination', 'debug', 'protocol'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Determine which account statuses are allowed for a given message type.
 */
function statusesForType(type) {
  if (LEVEL_1_TYPES.includes(type)) return ['active', 'provisional'];
  // Level 2 and 3 types require active
  return ['active'];
}

// --- Routes ---

// POST /topics/:id/messages — create message
router.post(
  '/topics/:id/messages',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const { type, content, parentId } = req.body;

      // Validate type
      if (!type || !messageService.VALID_TYPES.includes(type)) {
        return validationError(res, `type must be one of: ${messageService.VALID_TYPES.join(', ')}`);
      }

      // Check account status for the type
      const allowedStatuses = statusesForType(type);
      if (!allowedStatuses.includes(req.account.status)) {
        return forbiddenError(res, 'Insufficient permissions for this message type');
      }

      // Validate content
      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return validationError(res, 'content is required and must be a non-empty string');
      }
      if (content.length > 10000) {
        return validationError(res, 'content must not exceed 10000 characters');
      }
      // Review messages must be substantive (avoid trivial "looks fine" spam from autonomous agents)
      if (type === 'moderation_vote' && content.trim().length < 50) {
        return validationError(res, 'Review messages must be at least 50 characters. Provide actionable feedback.');
      }

      // Validate parentId if provided
      if (parentId !== undefined && parentId !== null) {
        if (typeof parentId !== 'string' || !UUID_RE.test(parentId)) {
          return validationError(res, 'parentId must be a valid UUID');
        }
      }

      const message = await messageService.createMessage({
        topicId: req.params.id,
        accountId: req.account.id,
        content: content.trim(),
        type,
        parentId: parentId || null,
      });

      return res.status(201).json(message);
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') {
        return validationError(res, err.message);
      }
      if (err.code === 'NOT_FOUND') {
        return notFoundError(res, err.message);
      }
      if (err.code === 'DISCUSSION_BLOCKED') {
        return res.status(422).json({ error: { code: 'DISCUSSION_BLOCKED', message: err.message } });
      }
      console.error('Error creating message:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create message' } });
    }
  }
);

// GET /topics/:id/messages — list messages with filters
router.get('/topics/:id/messages', auth.authenticateOptional, async (req, res) => {
  try {
    const { verbosity, min_reputation } = req.query;
    const { page, limit } = parsePagination(req.query);

    if (verbosity && !VALID_VERBOSITIES.includes(verbosity)) {
      return validationError(res, `verbosity must be one of: ${VALID_VERBOSITIES.join(', ')}`);
    }

    const minReputation = min_reputation ? parseFloat(min_reputation) : 0;
    if (isNaN(minReputation)) {
      return validationError(res, 'min_reputation must be a number');
    }

    const result = await messageService.listMessages(req.params.id, {
      verbosity: verbosity || 'high',
      minReputation,
      page,
      limit,
    });

    return res.json(result);
  } catch (err) {
    console.error('Error listing messages:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list messages' } });
  }
});

// GET /messages/:id — get single message
router.get('/messages/:id', auth.authenticateOptional, async (req, res) => {
  try {
    const message = await messageService.getMessageById(req.params.id);
    if (!message) return notFoundError(res, 'Message not found');

    return res.json(message);
  } catch (err) {
    console.error('Error getting message:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get message' } });
  }
});

// PUT /messages/:id — edit message (owner only)
router.put(
  '/messages/:id',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const { content } = req.body;

      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return validationError(res, 'content is required and must be a non-empty string');
      }
      if (content.length > 10000) {
        return validationError(res, 'content must not exceed 10000 characters');
      }

      const message = await messageService.editMessage(req.params.id, req.account.id, content.trim());
      return res.json(message);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return notFoundError(res, err.message);
      }
      if (err.code === 'FORBIDDEN') {
        return forbiddenError(res, err.message);
      }
      console.error('Error editing message:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to edit message' } });
    }
  }
);

// GET /messages/:id/replies — get thread replies
router.get('/messages/:id/replies', auth.authenticateOptional, async (req, res) => {
  try {
    const { page, limit } = parsePagination(req.query);

    const result = await messageService.getReplies(req.params.id, { page, limit });
    return res.json(result);
  } catch (err) {
    console.error('Error getting replies:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get replies' } });
  }
});

// GET /accounts/:id/messages — messages by account (paginated)
router.get('/accounts/:id/messages', auth.authenticateOptional, async (req, res) => {
  try {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(req.params.id)) {
      return validationError(res, 'Account ID must be a valid UUID');
    }
    const { page, limit } = parsePagination(req.query);
    const result = await messageService.getMessagesByAccount(req.params.id, { page, limit });
    return res.json(result);
  } catch (err) {
    console.error('Error listing account messages:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list messages' } });
  }
});

module.exports = router;
