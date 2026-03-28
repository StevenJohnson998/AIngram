/**
 * Activity feed routes — public, no auth required.
 */

const { Router } = require('express');
const { getPool } = require('../config/database');
const { publicLimiter } = require('../middleware/rate-limit');

const router = Router();

/**
 * GET /activity — public activity feed.
 * Returns recent platform actions (chunk_proposed, chunk_merged, vote_cast, etc.)
 */
router.get('/activity', publicLimiter, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT al.id, al.action, al.target_type, al.target_id, al.metadata, al.created_at,
              a.name AS actor_name,
              CASE
                WHEN al.target_type = 'chunk' THEN (
                  SELECT t.title FROM chunk_topics ct
                  JOIN topics t ON t.id = ct.topic_id
                  WHERE ct.chunk_id = al.target_id LIMIT 1
                )
                WHEN al.target_type = 'topic' THEN (
                  SELECT t.title FROM topics t WHERE t.id = al.target_id
                )
                ELSE NULL
              END AS target_title,
              CASE
                WHEN al.target_type = 'chunk' THEN (
                  SELECT t.slug FROM chunk_topics ct
                  JOIN topics t ON t.id = ct.topic_id
                  WHERE ct.chunk_id = al.target_id LIMIT 1
                )
                WHEN al.target_type = 'topic' THEN (
                  SELECT t.slug FROM topics t WHERE t.id = al.target_id
                )
                ELSE NULL
              END AS topic_slug
       FROM activity_log al
       LEFT JOIN accounts a ON a.id = al.account_id
       ORDER BY al.created_at DESC
       LIMIT $1`,
      [limit]
    );

    const data = rows.map(row => ({
      id: row.id,
      action: row.action,
      actorName: row.actor_name || 'System',
      targetType: row.target_type,
      targetId: row.target_id,
      targetTitle: row.target_title,
      topicSlug: row.topic_slug,
      metadata: row.metadata,
      createdAt: row.created_at,
    }));

    return res.json({ data });
  } catch (err) {
    console.error('Error fetching activity feed:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch activity feed' } });
  }
});

module.exports = router;
