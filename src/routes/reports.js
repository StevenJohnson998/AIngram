/**
 * Report routes — public content reporting (LCEN/DSA compliance).
 */

const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const reportService = require('../services/report');
const auth = require('../middleware/auth');
const { authenticatedLimiter } = require('../middleware/rate-limit');
const { requireBadge } = require('../middleware/badge');
const { validationError } = require('../utils/http-errors');

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isTest = process.env.NODE_ENV === 'test';

// Public report rate limit: 5 per hour per IP
const reportLimiter = isTest ? (_req, _res, next) => next() : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  handler: (_req, res) => {
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Too many reports. Try again later.' },
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { default: false },
});

// POST /reports — public, no auth required
router.post(
  '/reports',
  reportLimiter,
  async (req, res) => {
    try {
      const { contentId, contentType, reason, reporterEmail } = req.body;

      if (!contentId || typeof contentId !== 'string' || !UUID_RE.test(contentId)) {
        return validationError(res, 'contentId must be a valid UUID');
      }
      if (!contentType || !reportService.VALID_CONTENT_TYPES.includes(contentType)) {
        return validationError(res, `contentType must be one of: ${reportService.VALID_CONTENT_TYPES.join(', ')}`);
      }
      if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
        return validationError(res, 'reason is required (minimum 10 characters)');
      }
      if (!reporterEmail || typeof reporterEmail !== 'string' || !reporterEmail.includes('@')) {
        return validationError(res, 'A valid reporterEmail is required');
      }

      const report = await reportService.createReport({
        contentId,
        contentType,
        reason: reason.trim(),
        reporterEmail: reporterEmail.trim(),
      });

      return res.status(201).json({
        ...report,
        message: 'Report received. We will review it within 24-48 hours.',
      });
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') return validationError(res, err.message);
      if (err.code === 'NOT_FOUND') return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      console.error('Error creating report:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create report' } });
    }
  }
);

// GET /reports — admin (badge policing required)
router.get(
  '/reports',
  auth.authenticateRequired, authenticatedLimiter,
  requireBadge('policing'),
  async (req, res) => {
    try {
      const { status, page, limit } = req.query;
      const result = await reportService.listReports({
        status: status || 'pending',
        page: parseInt(page, 10) || 1,
        limit: Math.min(parseInt(limit, 10) || 20, 100),
      });
      return res.json(result);
    } catch (err) {
      console.error('Error listing reports:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list reports' } });
    }
  }
);

// PATCH /reports/:id — resolve or dismiss (admin)
router.patch(
  '/reports/:id',
  auth.authenticateRequired, authenticatedLimiter,
  requireBadge('policing'),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return validationError(res, 'Invalid report ID');

      const { status, adminNotes } = req.body;
      if (!status || !['resolved', 'dismissed'].includes(status)) {
        return validationError(res, 'status must be resolved or dismissed');
      }

      const report = await reportService.resolveReport(id, {
        status,
        adminNotes: adminNotes || null,
        resolvedBy: req.account.id,
      });

      return res.json(report);
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') return validationError(res, err.message);
      if (err.code === 'NOT_FOUND') return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
      console.error('Error resolving report:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve report' } });
    }
  }
);

module.exports = router;
