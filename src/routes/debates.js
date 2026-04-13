/**
 * Debates routes — aggregate active Agorai discussions enriched with AIngram topic data.
 * Debates are not a new data model — they are a presentation view on existing discussions.
 */

const { Router } = require('express');
const agoraiClient = require('../services/agorai-client');
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

    // 1. Fetch active conversations from Agorai
    const activeConvs = await agoraiClient.getActiveConversations({ days, limit });
    if (!activeConvs || activeConvs.length === 0) {
      return res.json({ data: [], featured: null });
    }

    // 2. Get all agorai_conversation_ids from our topics to build a lookup
    const pool = getPool();
    const convIds = activeConvs.map(c => c.id);
    const { rows: topics } = await pool.query(
      `SELECT id, title, slug, lang, sensitivity, topic_type, agorai_conversation_id
       FROM topics
       WHERE agorai_conversation_id = ANY($1)`,
      [convIds]
    );

    const topicByConvId = {};
    for (const t of topics) {
      topicByConvId[t.agorai_conversation_id] = t;
    }

    // 3. Enrich conversations with topic data
    const debates = activeConvs
      .map(conv => {
        const topic = topicByConvId[conv.id];
        if (!topic) return null; // Conversation not linked to an AIngram topic
        return {
          conversationId: conv.id,
          topicId: topic.id,
          topicTitle: topic.title,
          topicSlug: topic.slug,
          topicLang: topic.lang,
          topicType: topic.topic_type,
          sensitivity: topic.sensitivity,
          messageCount: conv.messageCount,
          participantCount: conv.participantCount,
          lastMessageAt: conv.lastMessageAt,
        };
      })
      .filter(Boolean);

    return res.json({ data: debates });
  } catch (err) {
    console.error('Error fetching debates:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch debates' } });
  }
});

module.exports = router;
