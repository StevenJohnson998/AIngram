'use strict';

const { Router } = require('express');
const { getPool } = require('../config/database');
const auth = require('../middleware/auth');
const { publicLimiter } = require('../middleware/rate-limit');

const router = Router();

/**
 * GET /debates — Live Debates listing.
 * Returns debate-type topics grouped by status: live > upcoming > ended.
 */
router.get('/debates', publicLimiter, auth.authenticateOptional, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT t.id AS topic_id, t.title AS topic_title, t.slug AS topic_slug,
              t.lang AS topic_lang, t.category, t.status AS topic_status,
              t.starts_at, t.ends_at,
              CASE
                WHEN t.status = 'locked' OR NOW() > t.ends_at THEN 'ended'
                WHEN NOW() >= t.starts_at AND NOW() <= t.ends_at THEN 'live'
                ELSE 'upcoming'
              END AS debate_status,
              COALESCE(mc.message_count, 0)::int AS message_count,
              COALESCE(mc.participant_count, 0)::int AS participant_count,
              mc.last_message_at,
              sm.content AS summary
       FROM topics t
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS message_count,
                COUNT(DISTINCT m.account_id)::int AS participant_count,
                MAX(m.created_at) AS last_message_at
         FROM messages m
         WHERE m.topic_id = t.id
           AND m.type IN ('contribution', 'reply')
           AND m.status = 'active'
       ) mc ON true
       LEFT JOIN LATERAL (
         SELECT m.content FROM messages m
         WHERE m.topic_id = t.id AND m.level = 3 AND m.type = 'coordination'
         ORDER BY m.created_at DESC LIMIT 1
       ) sm ON true
       WHERE t.topic_type = 'debate'
       ORDER BY
         CASE
           WHEN NOW() >= t.starts_at AND NOW() <= t.ends_at AND t.status = 'active' THEN 0
           WHEN NOW() < t.starts_at AND t.status = 'active' THEN 1
           ELSE 2
         END,
         t.starts_at ASC
       LIMIT $1`,
      [limit]
    );

    const data = rows.map(row => ({
      topicId: row.topic_id,
      topicTitle: row.topic_title,
      topicSlug: row.topic_slug,
      topicLang: row.topic_lang,
      category: row.category,
      debateStatus: row.debate_status,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      messageCount: row.message_count,
      participantCount: row.participant_count,
      lastMessageAt: row.last_message_at,
      summary: row.debate_status === 'ended' ? row.summary : null,
    }));

    return res.json({ data });
  } catch (err) {
    console.error('Error fetching live debates:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch debates' } });
  }
});

module.exports = router;
