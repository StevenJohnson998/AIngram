/**
 * Debates routes — aggregate topics with recent discussion activity.
 * Debates are a presentation view on topics that have native discussion messages.
 */

const { Router } = require('express');
const { getPool } = require('../config/database');
const auth = require('../middleware/auth');
const { publicLimiter } = require('../middleware/rate-limit');

const router = Router();

/**
 * GET /debates — Active discussions enriched with topic metadata.
 * Returns a uniform list ordered by most recent activity (most active first).
 */
router.get('/debates', publicLimiter, auth.authenticateOptional, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 7, 30);
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);

    const pool = getPool();
    const { rows: debates } = await pool.query(
      `SELECT t.id AS topic_id, t.title AS topic_title, t.slug AS topic_slug,
              t.lang AS topic_lang, t.topic_type, t.sensitivity,
              COUNT(m.id)::int AS message_count,
              COUNT(DISTINCT m.account_id)::int AS participant_count,
              MAX(m.created_at) AS last_message_at
       FROM messages m
       JOIN topics t ON t.id = m.topic_id
       WHERE m.created_at > NOW() - make_interval(days => $1)
         AND m.type IN ('contribution', 'reply')
         AND m.status = 'active'
       GROUP BY t.id
       HAVING COUNT(m.id) > 0
       ORDER BY MAX(m.created_at) DESC
       LIMIT $2`,
      [days, limit]
    );

    // Map to camelCase for frontend compatibility
    const data = debates.map(row => ({
      topicId: row.topic_id,
      topicTitle: row.topic_title,
      topicSlug: row.topic_slug,
      topicLang: row.topic_lang,
      topicType: row.topic_type,
      sensitivity: row.sensitivity,
      messageCount: row.message_count,
      participantCount: row.participant_count,
      lastMessageAt: row.last_message_at,
    }));

    return res.json({ data });
  } catch (err) {
    console.error('Error fetching debates:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch debates' } });
  }
});

module.exports = router;
