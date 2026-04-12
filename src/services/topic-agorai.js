'use strict';

const { getPool } = require('../config/database');
const agoraiClient = require('./agorai-client');
const { AgoraiError } = agoraiClient;

/**
 * Create an Agorai conversation and link it to a topic.
 * @param {string} topicId
 * @param {string} title
 * @returns {Promise<{ conversationId: string }|null>}
 */
async function linkTopicToConversation(topicId, title) {
  const conversationId = await agoraiClient.createConversation(title);
  if (!conversationId) return null;

  try {
    const pool = getPool();
    await pool.query(
      'UPDATE topics SET agorai_conversation_id = $1 WHERE id = $2',
      [conversationId, topicId]
    );
    return { conversationId };
  } catch (err) {
    console.warn(`[topic-agorai] linkTopicToConversation DB error: ${err.message}`);
    return null;
  }
}

/**
 * Fetch discussion messages for a topic via its linked Agorai conversation.
 * @param {string} topicId
 * @param {{ limit?: number, offset?: number }} options
 * @returns {Promise<{ messages: Array, total: number, available: boolean }>}
 */
async function getDiscussion(topicId, { limit = 50, offset = 0 } = {}) {
  const unavailable = { messages: [], total: 0, available: false };

  try {
    const pool = getPool();
    const result = await pool.query(
      'SELECT agorai_conversation_id, title FROM topics WHERE id = $1',
      [topicId]
    );

    if (result.rows.length === 0) return unavailable;

    const conversationId = result.rows[0].agorai_conversation_id;
    if (!conversationId) return { messages: [], total: 0, available: true };

    const { messages, total } = await agoraiClient.getMessages(conversationId, { limit, offset });

    // Enrich messages with account names from AIngram
    // Agorai stores accountId/accountName in message metadata (set at send time)
    // Fallback: match by timestamp against activity_log discussion_post entries
    try {
      const { rows: discLogs } = await pool.query(
        `SELECT al.account_id, a.name, al.created_at
         FROM activity_log al
         JOIN accounts a ON a.id = al.account_id
         WHERE al.action = 'discussion_post' AND al.target_type = 'topic' AND al.target_id = $1
         ORDER BY al.created_at DESC
         LIMIT 100`,
        [topicId]
      );
      // Match by closest timestamp (within 2s window)
      for (const msg of messages) {
        // First try metadata (if Agorai preserved it)
        if (msg.metadata && msg.metadata.accountName) {
          msg.account_name = msg.metadata.accountName;
          continue;
        }
        // Fallback: match by timestamp
        const msgTime = new Date(msg.createdAt).getTime();
        const match = discLogs.find(log => Math.abs(new Date(log.created_at).getTime() - msgTime) < 2000);
        msg.account_name = match ? match.name : null;
      }
    } catch { /* non-critical */ }

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
  } catch (err) {
    console.warn(`[topic-agorai] getDiscussion error: ${err.message}`);
    return unavailable;
  }
}

/**
 * Post a message to a topic's Agorai conversation.
 * AIngram manages users — Agorai conversations are wild-agora (open participation).
 * Auto-creates the conversation if none is linked yet.
 * @param {string} topicId
 * @param {{ content: string, accountId: string, accountName: string, level?: number }} params
 * @returns {Promise<object|null>} message object or null
 */
async function postToDiscussion(topicId, { content, accountId, accountName, level = 1 }) {
  try {
    const pool = getPool();
    const result = await pool.query(
      'SELECT agorai_conversation_id, title FROM topics WHERE id = $1',
      [topicId]
    );

    if (result.rows.length === 0) return null;

    let conversationId = result.rows[0].agorai_conversation_id;
    const title = result.rows[0].title;

    // Auto-create conversation if not linked
    if (!conversationId) {
      const linked = await linkTopicToConversation(topicId, title);
      if (!linked) return null;
      conversationId = linked.conversationId;
    }

    return await agoraiClient.sendMessage(conversationId, { content, accountId, accountName, level });
  } catch (err) {
    // Propagate content rejection errors so routes can show user-facing messages
    if (err instanceof AgoraiError) throw err;
    console.warn(`[topic-agorai] postToDiscussion error: ${err.message}`);
    return null;
  }
}

module.exports = { linkTopicToConversation, getDiscussion, postToDiscussion };
