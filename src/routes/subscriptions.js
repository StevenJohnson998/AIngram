/**
 * Subscription routes — CRUD + polling notifications.
 */

const { Router } = require('express');
const subscriptionService = require('../services/subscription');
const notificationService = require('../services/notification');

const auth = require('../middleware/auth');
const { authenticatedLimiter } = require('../middleware/rate-limit');
const { validationError } = require('../utils/http-errors');
const { parsePagination } = require('../utils/pagination');
const { VALID_LANGS } = require('../config/constants');

const router = Router();

const VALID_TYPES = ['topic', 'keyword', 'vector'];
const VALID_METHODS = ['webhook', 'a2a', 'polling'];

function isValidUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// --- Routes ---

// POST /subscriptions — create subscription
router.post(
  '/subscriptions',
  auth.authenticateRequired, authenticatedLimiter,
  auth.requireStatus('active', 'provisional'),
  async (req, res) => {
    try {
      const {
        type,
        topicId,
        keyword,
        embeddingText,
        similarityThreshold,
        lang,
        notificationMethod,
        webhookUrl,
      } = req.body;

      // Validate type
      if (!type || !VALID_TYPES.includes(type)) {
        return validationError(res, `Type must be one of: ${VALID_TYPES.join(', ')}`);
      }

      // Validate notification method
      if (notificationMethod && !VALID_METHODS.includes(notificationMethod)) {
        return validationError(res, `Notification method must be one of: ${VALID_METHODS.join(', ')}`);
      }

      // Validate webhookUrl if method is webhook
      const method = notificationMethod || 'webhook';
      if (method === 'webhook') {
        if (!webhookUrl) {
          return validationError(res, 'webhookUrl is required when notification method is webhook');
        }
        if (!isValidUrl(webhookUrl)) {
          return validationError(res, 'webhookUrl must be a valid HTTP(S) URL');
        }
      }

      // Validate similarity threshold
      if (similarityThreshold !== undefined) {
        const t = parseFloat(similarityThreshold);
        if (isNaN(t) || t < 0 || t > 1) {
          return validationError(res, 'similarityThreshold must be between 0.0 and 1.0');
        }
      }

      // Validate lang
      if (lang && !VALID_LANGS.includes(lang)) {
        return validationError(res, `Lang must be one of: ${VALID_LANGS.join(', ')}`);
      }

      const subscription = await subscriptionService.createSubscription({
        accountId: req.account.id,
        type,
        topicId,
        keyword,
        embeddingText,
        similarityThreshold: similarityThreshold !== undefined ? parseFloat(similarityThreshold) : undefined,
        lang,
        notificationMethod: method,
        webhookUrl,
      });

      return res.status(201).json(subscription);
    } catch (err) {
      if (err.code === 'LIMIT_REACHED') {
        return res.status(429).json({ error: { code: 'LIMIT_REACHED', message: err.message } });
      }
      if (err.code === 'VALIDATION_ERROR') {
        return validationError(res, err.message);
      }
      if (err.code === 'EMBEDDING_FAILED') {
        return res.status(503).json({ error: { code: 'EMBEDDING_FAILED', message: err.message } });
      }
      console.error('Error creating subscription:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create subscription' } });
    }
  }
);

// GET /subscriptions/me — list my subscriptions
router.get(
  '/subscriptions/me',
  auth.authenticateRequired,
  async (req, res) => {
    try {
      const { page, limit } = parsePagination(req.query);
      const result = await subscriptionService.listMySubscriptions(req.account.id, { page, limit });
      return res.json(result);
    } catch (err) {
      console.error('Error listing subscriptions:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list subscriptions' } });
    }
  }
);

// GET /subscriptions/notifications — polling endpoint for recent matches
router.get(
  '/subscriptions/notifications',
  auth.authenticateRequired,
  async (req, res) => {
    try {
      const { since, limit: rawLimit } = req.query;
      const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 20, 1), 100);
      const result = await notificationService.getPendingNotifications(req.account.id, { since, limit });
      return res.json(result);
    } catch (err) {
      console.error('Error getting notifications:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get notifications' } });
    }
  }
);

// GET /subscriptions/dead-letter — list dead-letter notifications (admin, badge policing)
router.get(
  '/subscriptions/dead-letter',
  auth.authenticateRequired,
  async (req, res) => {
    try {
      // Check policing badge via req.account
      if (!req.account.badgePolicing) {
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Requires policing badge' },
        });
      }
      const { page, limit: rawLimit } = req.query;
      const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 20, 1), 100);
      const result = await notificationService.listDeadLetters({
        page: parseInt(page, 10) || 1,
        limit,
      });
      return res.json(result);
    } catch (err) {
      console.error('Error listing dead-letter notifications:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list dead-letter notifications' } });
    }
  }
);

// GET /subscriptions/:id — get subscription by ID (owner only)
router.get(
  '/subscriptions/:id',
  auth.authenticateRequired,
  async (req, res) => {
    try {
      const subscription = await subscriptionService.getSubscriptionById(req.params.id);
      if (!subscription) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Subscription not found' } });
      }
      if (subscription.account_id !== req.account.id) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not authorized to view this subscription' } });
      }
      return res.json(subscription);
    } catch (err) {
      console.error('Error getting subscription:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get subscription' } });
    }
  }
);

// PUT /subscriptions/:id — update subscription (owner only)
router.put(
  '/subscriptions/:id',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      const { similarityThreshold, webhookUrl, active, lang } = req.body;

      // Validate similarity threshold if provided
      if (similarityThreshold !== undefined) {
        const t = parseFloat(similarityThreshold);
        if (isNaN(t) || t < 0 || t > 1) {
          return validationError(res, 'similarityThreshold must be between 0.0 and 1.0');
        }
      }

      // Validate webhookUrl if provided
      if (webhookUrl !== undefined && webhookUrl !== null && !isValidUrl(webhookUrl)) {
        return validationError(res, 'webhookUrl must be a valid HTTP(S) URL');
      }

      // Validate lang if provided
      if (lang !== undefined && lang !== null && !VALID_LANGS.includes(lang)) {
        return validationError(res, `Lang must be one of: ${VALID_LANGS.join(', ')}`);
      }

      const subscription = await subscriptionService.updateSubscription(req.params.id, req.account.id, {
        similarityThreshold: similarityThreshold !== undefined ? parseFloat(similarityThreshold) : undefined,
        webhookUrl,
        active,
        lang,
      });

      return res.json(subscription);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      }
      if (err.code === 'FORBIDDEN') {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: err.message } });
      }
      if (err.code === 'VALIDATION_ERROR') {
        return validationError(res, err.message);
      }
      console.error('Error updating subscription:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update subscription' } });
    }
  }
);

// DELETE /subscriptions/:id — delete subscription (owner only)
router.delete(
  '/subscriptions/:id',
  auth.authenticateRequired, authenticatedLimiter,
  async (req, res) => {
    try {
      await subscriptionService.deleteSubscription(req.params.id, req.account.id);
      return res.status(204).end();
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      }
      if (err.code === 'FORBIDDEN') {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: err.message } });
      }
      console.error('Error deleting subscription:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete subscription' } });
    }
  }
);

module.exports = router;
