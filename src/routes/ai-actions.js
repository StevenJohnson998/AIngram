const { Router } = require('express');
const aiActionService = require('../services/ai-action');
const accountService = require('../services/account');
const { authenticateRequired } = require('../middleware/auth');
const { authenticatedLimiter } = require('../middleware/rate-limit');

const router = Router();

const VALID_ACTION_TYPES = ['summary', 'contribute', 'review', 'reply', 'draft', 'refresh', 'discuss_proposal'];
const VALID_TARGET_TYPES = ['topic', 'chunk', 'discussion', 'search', 'changeset'];

// X-Agent-Model header carries the LLM model identifier (e.g. "claude-opus-4-6",
// "deepseek-chat-v3.1"). Client-supplied, sanitized before storage: cap at 128
// chars and strip anything outside [A-Za-z0-9._:/-]. Empty/invalid -> null.
const AGENT_MODEL_MAX = 128;
const AGENT_MODEL_ALLOWED = /^[A-Za-z0-9._:/-]+$/;
function extractAgentModel(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, AGENT_MODEL_MAX);
  if (!trimmed || !AGENT_MODEL_ALLOWED.test(trimmed)) return null;
  return trimmed;
}

/**
 * POST /ai/actions — execute an AI action on behalf of an assisted agent
 */
router.post('/', authenticateRequired, authenticatedLimiter, async (req, res) => {
  try {
    // Only root human accounts can trigger assisted actions
    if (req.account.type !== 'human' || req.account.parentId) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Only root human accounts can trigger AI actions' },
      });
    }

    const { agentId, providerId, actionType, targetType, targetId, context } = req.body;

    if (!agentId || !actionType) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Missing required fields: agentId, actionType' },
      });
    }

    if (!VALID_ACTION_TYPES.includes(actionType)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `actionType must be one of: ${VALID_ACTION_TYPES.join(', ')}` },
      });
    }

    if (targetType && !VALID_TARGET_TYPES.includes(targetType)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `targetType must be one of: ${VALID_TARGET_TYPES.join(', ')}` },
      });
    }

    // Verify the agent belongs to this human
    const agent = await accountService.findById(agentId);
    if (!agent || agent.parent_id !== req.account.id) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Agent not found or not owned by you' },
      });
    }

    if (agent.autonomous) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Cannot trigger assisted actions for autonomous agents. Use the agent\'s API key instead.' },
      });
    }

    // Execute the action
    const { actionId, result, inputTokens, outputTokens } = await aiActionService.executeAction({
      agentId,
      parentId: req.account.id,
      providerId,
      actionType,
      targetType,
      targetId,
      context: context || {},
      agentModel: extractAgentModel(req.get('x-agent-model')),
    });

    return res.status(200).json({
      actionId,
      result,
      usage: { inputTokens, outputTokens },
    });
  } catch (err) {
    if (err.code === 'NOT_FOUND' || err.code === 'PROVIDER_REQUIRED') {
      return res.status(400).json({ error: { code: err.code, message: err.message } });
    }
    console.error('AI action error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'AI action failed. Check your provider configuration.' },
    });
  }
});

/**
 * POST /ai/actions/:id/dispatch — dispatch an action result as real contributions
 */
router.post('/:id/dispatch', authenticateRequired, authenticatedLimiter, async (req, res) => {
  try {
    const { getPool } = require('../config/database');
    const pool = getPool();

    // Get the action
    const actionResult = await pool.query(
      'SELECT * FROM ai_actions WHERE id = $1 AND parent_id = $2',
      [req.params.id, req.account.id]
    );

    if (actionResult.rows.length === 0) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Action not found' },
      });
    }

    const action = actionResult.rows[0];

    if (action.status !== 'completed') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Action is not completed' },
      });
    }

    // Allow overriding the result content before dispatching
    const result = req.body.result || action.result;

    const dispatched = await aiActionService.dispatchResult({
      actionId: action.id,
      agentId: action.agent_id,
      actionType: action.action_type,
      targetType: action.target_type,
      targetId: action.target_id,
      result,
    });

    if (dispatched.alreadyDispatched) {
      return res.status(409).json({
        error: { code: 'ALREADY_DISPATCHED', message: 'This action has already been dispatched' },
      });
    }

    return res.status(200).json({ dispatched });
  } catch (err) {
    console.error('Dispatch error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Dispatch failed' },
    });
  }
});

/**
 * GET /ai/actions — get action history
 */
router.get('/', authenticateRequired, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    const actions = await aiActionService.getActionHistory(req.account.id, { limit, offset });
    return res.status(200).json({ actions });
  } catch (err) {
    console.error('Action history error:', err.message);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

module.exports = router;
module.exports.extractAgentModel = extractAgentModel;
