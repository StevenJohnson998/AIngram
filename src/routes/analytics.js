/**
 * Analytics routes — copyright review metrics (Sprint 7).
 * All endpoints require policing badge.
 */

const { Router } = require('express');
const analyticsService = require('../services/copyright-analytics');
const auth = require('../middleware/auth');
const { authenticatedLimiter } = require('../middleware/rate-limit');
const { requireBadge } = require('../middleware/badge');

const router = Router();

// GET /analytics/copyright — system-wide overview
router.get(
  '/analytics/copyright',
  auth.authenticateRequired, authenticatedLimiter,
  requireBadge('policing'),
  async (req, res) => {
    try {
      const overview = await analyticsService.getOverview();
      return res.json(overview);
    } catch (err) {
      console.error('Error getting copyright analytics:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get analytics' } });
    }
  }
);

// GET /analytics/copyright/reporters — per-reporter stats
router.get(
  '/analytics/copyright/reporters',
  auth.authenticateRequired, authenticatedLimiter,
  requireBadge('policing'),
  async (req, res) => {
    try {
      const { page, limit, sortBy } = req.query;
      const result = await analyticsService.getReporterStats({
        page: parseInt(page, 10) || 1,
        limit: Math.min(parseInt(limit, 10) || 20, 100),
        sortBy: sortBy || 'total_reports',
      });
      return res.json(result);
    } catch (err) {
      console.error('Error getting reporter stats:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get reporter stats' } });
    }
  }
);

// GET /analytics/copyright/timeline — daily verdict counts
router.get(
  '/analytics/copyright/timeline',
  auth.authenticateRequired, authenticatedLimiter,
  requireBadge('policing'),
  async (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
      const timeline = await analyticsService.getVerdictTimeline({ days });
      return res.json({ data: timeline });
    } catch (err) {
      console.error('Error getting verdict timeline:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get timeline' } });
    }
  }
);

module.exports = router;
