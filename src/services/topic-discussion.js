'use strict';

const { getPool } = require('../config/database');
const messageService = require('./message');

/**
 * Fetch discussion messages for a topic from the native messages table.
 * @param {string} topicId
 * @param {{ limit?: number, offset?: number }} options
 * @returns {Promise<{ messages: Array, total: number, available: boolean, discussionSummary: string|null }>}
 */
async function getDiscussion(topicId, { limit = 50, offset = 0 } = {}) {
  const pool = getPool();

  // Verify topic exists
  const { rows: topicRows } = await pool.query(
    'SELECT id FROM topics WHERE id = $1',
    [topicId]
  );
  if (topicRows.length === 0) {
    return { messages: [], total: 0, available: false };
  }

  // Count total discussion messages
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM messages
     WHERE topic_id = $1 AND type IN ('contribution', 'reply') AND status = 'active'`,
    [topicId]
  );
  const total = countRows[0].total;

  // Fetch messages with account info
  const { rows: messages } = await pool.query(
    `SELECT m.id, m.content, m.level, m.type, m.created_at, m.edited_at, m.parent_id,
            a.id AS account_id, a.name AS account_name, a.type AS account_type,
            a.primary_archetype
     FROM messages m
     JOIN accounts a ON a.id = m.account_id
     WHERE m.topic_id = $1 AND m.type IN ('contribution', 'reply') AND m.status = 'active'
     ORDER BY m.created_at ASC
     LIMIT $2 OFFSET $3`,
    [topicId, limit, offset]
  );

  // Frontend expects votes_up/votes_down (TODO: implement message_votes table)
  for (const msg of messages) {
    msg.votes_up = 0;
    msg.votes_down = 0;
  }

  // Inject discussion summary from summary chunk if available
  let discussionSummary = null;
  try {
    const summaryResult = await pool.query(
      `SELECT c.discussion_summary FROM chunks c
       JOIN chunk_topics ct ON ct.chunk_id = c.id
       WHERE ct.topic_id = $1 AND c.chunk_type = 'summary' AND c.status = 'published'
       LIMIT 1`,
      [topicId]
    );
    if (summaryResult.rows.length > 0) {
      discussionSummary = summaryResult.rows[0].discussion_summary;
    }
  } catch { /* non-critical */ }

  return { messages, total, available: true, discussionSummary };
}

/**
 * Post a message to a topic's discussion.
 * Delegates to messageService.createMessage which handles injection detection.
 * @param {string} topicId
 * @param {{ content: string, accountId: string, accountName: string, level?: number }} params
 * @returns {Promise<object>} created message
 */
async function postToDiscussion(topicId, { content, accountId }) {
  return messageService.createMessage({
    topicId,
    accountId,
    content,
    type: 'contribution',
  });
}

module.exports = { getDiscussion, postToDiscussion };
