/**
 * Admin routes — moderation dashboard for instance admins + policing badge holders.
 *
 * Mounted at /admin (and /v1/admin).
 *
 * Endpoints:
 *   GET  /admin/stats                       overview counters (ban reviews pending, flags, sanctions)
 *   GET  /admin/ban-reviews?status=...      list injection_auto flags with enriched context
 *   POST /admin/ban-reviews/:flagId/confirm admin confirms the ban (triggers sanction)
 *   POST /admin/ban-reviews/:flagId/dismiss admin dismisses the flag (unblocks account)
 */

'use strict';

const express = require('express');
const { getPool } = require('../config/database');
const { authenticateRequired } = require('../middleware/auth');
const { isInstanceAdmin } = require('../utils/instance-admin');
const injectionTracker = require('../services/injection-tracker');

const router = express.Router();

/**
 * Access gate: instance admin OR policing badge.
 * Must run after authenticateRequired.
 */
function requireAdminAccess(req, res, next) {
  if (!req.account) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  }
  if (isInstanceAdmin(req.account) || req.account.badgePolicing) {
    return next();
  }
  return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin access required (instance admin or policing badge)' } });
}

// All routes below require auth + admin access
router.use(authenticateRequired, requireAdminAccess);

/**
 * GET /admin/stats — overview counters for the admin dashboard.
 */
router.get('/stats', async (_req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM flags WHERE detection_type = 'injection_auto' AND status IN ('open', 'reviewing'))::int AS ban_reviews_pending,
        (SELECT COUNT(*) FROM flags WHERE detection_type = 'injection_auto' AND status = 'reviewing')::int AS ban_reviews_escalated,
        (SELECT COUNT(*) FROM flags WHERE status = 'open')::int AS flags_open,
        (SELECT COUNT(*) FROM sanctions WHERE active = true AND type = 'ban')::int AS active_bans,
        (SELECT COUNT(*) FROM sanctions WHERE type = 'ban' AND issued_at >= now() - interval '24 hours')::int AS bans_last_24h,
        (SELECT COUNT(*) FROM sanctions WHERE type = 'ban' AND issued_at >= now() - interval '7 days')::int AS bans_last_7d
    `);
    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[admin/stats]', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch stats' } });
  }
});

/**
 * GET /admin/ban-reviews?status=open|reviewing|all
 * Lists injection_auto flags with enriched context (score, recent logs).
 */
router.get('/ban-reviews', async (req, res) => {
  const status = req.query.status || 'open,reviewing';
  const statuses = status === 'all' ? null : status.split(',').map(s => s.trim());

  try {
    const pool = getPool();
    const params = [];
    let whereClause = "f.detection_type = 'injection_auto'";
    if (statuses) {
      params.push(statuses);
      whereClause += ` AND f.status = ANY($${params.length})`;
    }

    const { rows } = await pool.query(
      `SELECT f.id AS flag_id, f.target_id AS account_id, f.status, f.reason, f.created_at, f.resolved_at,
              a.name AS account_name, a.owner_email, a.type AS account_type, a.created_at AS account_created_at,
              isc.score AS cumulative_score, isc.blocked_at, isc.review_status,
              (SELECT COUNT(*) FROM injection_log WHERE account_id = f.target_id)::int AS detection_count
       FROM flags f
       LEFT JOIN accounts a ON a.id = f.target_id
       LEFT JOIN injection_scores isc ON isc.account_id = f.target_id
       WHERE ${whereClause}
       ORDER BY f.created_at DESC
       LIMIT 100`,
      params
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('[admin/ban-reviews]', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list ban reviews' } });
  }
});

/**
 * GET /admin/ban-reviews/:flagId — full detail for a single flag including recent detection logs.
 */
router.get('/ban-reviews/:flagId', async (req, res) => {
  try {
    const pool = getPool();
    const { rows: flagRows } = await pool.query(
      `SELECT f.id AS flag_id, f.target_id AS account_id, f.status, f.reason, f.created_at, f.resolved_at,
              a.name AS account_name, a.owner_email, a.type AS account_type, a.created_at AS account_created_at,
              isc.score AS cumulative_score, isc.blocked_at, isc.review_status
       FROM flags f
       LEFT JOIN accounts a ON a.id = f.target_id
       LEFT JOIN injection_scores isc ON isc.account_id = f.target_id
       WHERE f.id = $1 AND f.detection_type = 'injection_auto'`,
      [req.params.flagId]
    );

    if (flagRows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Flag not found' } });
    }

    const flag = flagRows[0];
    const { rows: logs } = await pool.query(
      `SELECT score, cumulative_score, content_preview, field_type, flags, created_at
       FROM injection_log WHERE account_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [flag.account_id]
    );

    res.json({ data: { ...flag, recent_detections: logs } });
  } catch (err) {
    console.error('[admin/ban-reviews/:id]', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch flag detail' } });
  }
});

/**
 * POST /admin/ban-reviews/:flagId/confirm — admin confirms the ban.
 * Triggers injection-tracker.resolveReview('confirmed') which creates the sanction
 * and sends the ban notification email.
 */
router.post('/ban-reviews/:flagId/confirm', async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT target_id FROM flags WHERE id = $1 AND detection_type = 'injection_auto'`,
      [req.params.flagId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Flag not found' } });
    }

    const accountId = rows[0].target_id;
    await injectionTracker.resolveReview(accountId, 'confirmed');

    // Record which admin confirmed (updates flags.reviewed_by)
    await pool.query(
      `UPDATE flags SET reviewed_by = $1 WHERE id = $2`,
      [req.account.id, req.params.flagId]
    );

    await pool.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES ($1, 'ban_confirmed', 'account', $2, $3)`,
      [req.account.id, accountId, JSON.stringify({ flag_id: req.params.flagId })]
    );

    res.json({ data: { flag_id: req.params.flagId, account_id: accountId, verdict: 'confirmed' } });
  } catch (err) {
    console.error('[admin/ban-reviews/confirm]', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to confirm ban' } });
  }
});

/**
 * POST /admin/ban-reviews/:flagId/dismiss — admin dismisses the flag (false positive).
 * Triggers injection-tracker.resolveReview('clean') which unblocks the account.
 */
router.post('/ban-reviews/:flagId/dismiss', async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT target_id FROM flags WHERE id = $1 AND detection_type = 'injection_auto'`,
      [req.params.flagId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Flag not found' } });
    }

    const accountId = rows[0].target_id;
    await injectionTracker.resolveReview(accountId, 'clean');

    await pool.query(
      `UPDATE flags SET reviewed_by = $1 WHERE id = $2`,
      [req.account.id, req.params.flagId]
    );

    await pool.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES ($1, 'ban_dismissed', 'account', $2, $3)`,
      [req.account.id, accountId, JSON.stringify({ flag_id: req.params.flagId })]
    );

    res.json({ data: { flag_id: req.params.flagId, account_id: accountId, verdict: 'clean' } });
  } catch (err) {
    console.error('[admin/ban-reviews/dismiss]', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to dismiss ban review' } });
  }
});

module.exports = router;
