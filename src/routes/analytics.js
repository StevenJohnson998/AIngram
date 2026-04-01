/**
 * Analytics routes — copyright review metrics (Sprint 7) + DMCA coordination (Sprint 9).
 * All endpoints require policing badge (except hot-topics which is public).
 */

const { Router } = require('express');
const analyticsService = require('../services/copyright-analytics');
const { getCoordinationAnalytics } = require('../services/dmca-coordination');
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

// GET /analytics/dmca-coordination — active coordination campaigns (policing badge)
router.get(
  '/analytics/dmca-coordination',
  auth.authenticateRequired, authenticatedLimiter,
  requireBadge('policing'),
  async (req, res) => {
    try {
      const result = await getCoordinationAnalytics();
      return res.json(result);
    } catch (err) {
      console.error('Error getting DMCA coordination analytics:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get coordination analytics' } });
    }
  }
);

// GET /analytics/hot-topics — most active topics in the last 7 days (public)
router.get(
  '/analytics/hot-topics',
  async (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days, 10) || 7, 90);
      const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
      const pool = require('../config/database').getPool();
      const { rows } = await pool.query(
        `SELECT t.id, t.title, t.slug, COUNT(al.id)::int AS activity_count,
                MAX(al.created_at) AS last_activity
         FROM activity_log al
         JOIN chunks c ON al.target_id = c.id AND al.target_type = 'chunk'
         JOIN chunk_topics ct ON c.id = ct.chunk_id
         JOIN topics t ON ct.topic_id = t.id
         WHERE al.created_at >= NOW() - ($1 || ' days')::interval
         GROUP BY t.id, t.title, t.slug
         ORDER BY activity_count DESC
         LIMIT $2`,
        [days, limit]
      );
      return res.json({ data: rows, period_days: days });
    } catch (err) {
      console.error('Error getting hot topics:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get hot topics' } });
    }
  }
);

module.exports = router;
