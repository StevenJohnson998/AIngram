'use strict';

/**
 * Agent behavioral feedback routes.
 * Emitters only ever send {code, scope, severity} — no free-text path (anti-injection).
 */

const express = require('express');
const auth = require('../middleware/auth');
const { authenticatedLimiter, feedbackIssueLimiter } = require('../middleware/rate-limit');
const feedbackService = require('../services/agent-feedback');

const router = express.Router();

/**
 * Emitter gate: trusted human (tier 2+) OR account id whitelisted via
 * FEEDBACK_EMITTERS (comma-separated UUIDs — our own system-role agents).
 * requireTier alone cannot express the type check + whitelist OR.
 */
function requireFeedbackEmitter(req, res, next) {
  const whitelist = (process.env.FEEDBACK_EMITTERS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const isTrustedHuman = req.account.type === 'human' && (req.account.tier || 0) >= 2;
  if (isTrustedHuman || whitelist.includes(req.account.id)) return next();
  return res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: 'Feedback can only be issued by trusted humans (tier 2+) or whitelisted accounts.',
    },
  });
}

// POST /accounts/:id/feedback — issue a predefined feedback item to an agent
router.post(
  '/accounts/:id/feedback',
  auth.authenticateRequired, feedbackIssueLimiter, requireFeedbackEmitter,
  async (req, res) => {
    try {
      const { code, scope, severity } = req.body || {};
      if (!code || typeof code !== 'string') {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'code is required' } });
      }
      const row = await feedbackService.issueFeedback({
        targetAccountId: req.params.id,
        code,
        scopeType: (scope && scope.type) || 'global',
        scopeId: (scope && scope.id) || null,
        severity: severity || 'notice',
        issuedBy: req.account.id,
      });
      return res.status(201).json({
        id: row.id,
        code: row.code,
        scope: { type: row.scope_type, id: row.scope_id },
        severity: row.severity,
        expires_at: row.expires_at,
      });
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.message } });
      }
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      }
      if (err.code === 'CONFLICT') {
        return res.status(409).json({
          error: { code: 'CONFLICT', message: err.message },
          existing_id: err.existingId,
        });
      }
      console.error('Error issuing feedback:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to issue feedback' } });
    }
  }
);

// GET /accounts/me/feedback — pending feedback for the caller, rendered
router.get(
  '/accounts/me/feedback',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const feedback = await feedbackService.listPendingForAccount(req.account.id);
      return res.json({ feedback, count: feedback.length });
    } catch (err) {
      console.error('Error listing feedback:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list feedback' } });
    }
  }
);

// POST /accounts/me/feedback/:fid/ack — acknowledge one item
router.post(
  '/accounts/me/feedback/:fid/ack',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const acked = await feedbackService.ackFeedback(req.account.id, req.params.fid);
      if (!acked) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No pending feedback item with this id' } });
      }
      return res.json({ acked: true });
    } catch (err) {
      console.error('Error acking feedback:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to ack feedback' } });
    }
  }
);

// DELETE /accounts/:id/feedback/:fid — revoke (issuer or trusted human)
router.delete(
  '/accounts/:id/feedback/:fid',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const result = await feedbackService.revokeFeedback({
        feedbackId: req.params.fid,
        targetAccountId: req.params.id,
        revokedBy: req.account.id,
        revokerTier: req.account.tier,
        revokerType: req.account.type,
      });
      if (!result.ok) {
        const status = result.reason === 'FORBIDDEN' ? 403 : 404;
        return res.status(status).json({ error: { code: result.reason, message: result.reason === 'FORBIDDEN' ? 'Only the issuer or a trusted human can revoke feedback' : 'Feedback item not found' } });
      }
      return res.status(204).end();
    } catch (err) {
      console.error('Error revoking feedback:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to revoke feedback' } });
    }
  }
);

module.exports = router;
module.exports.requireFeedbackEmitter = requireFeedbackEmitter;
