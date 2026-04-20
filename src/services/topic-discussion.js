'use strict';

const { getPool } = require('../config/database');
const messageService = require('./message');
const { MESSAGE_EDIT_WINDOW_MS } = require('../config/protocol');

/**
 * Fetch discussion messages for a topic from the native messages table.
 * @param {string} topicId
 * @param {{ limit?: number, offset?: number, viewerAccountId?: string|null }} options
 * @returns {Promise<{ messages: Array, total: number, available: boolean, discussionSummary: string|null }>}
 */
async function getDiscussion(topicId, { limit = 50, offset = 0, viewerAccountId = null } = {}) {
  const pool = getPool();

  // Verify topic exists
  const { rows: topicRows } = await pool.query(
    'SELECT id FROM topics WHERE id = $1',
    [topicId]
  );
  if (topicRows.length === 0) {
    return { messages: [], total: 0, available: false };
  }

  // Count total discussion messages (include retracted/hidden since they are shown)
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM messages
     WHERE topic_id = $1 AND type IN ('contribution', 'reply')
       AND status IN ('active', 'retracted', 'hidden')`,
    [topicId]
  );
  const total = countRows[0].total;

  // Fetch messages with account info + moderator name for hidden messages
  const { rows: messages } = await pool.query(
    `SELECT m.id, m.content, m.level, m.type, m.status, m.created_at, m.edited_at, m.parent_id,
            m.retracted_by,
            a.id AS account_id, a.name AS account_name, a.type AS account_type,
            a.primary_archetype,
            mod.name AS hidden_by_name
     FROM messages m
     JOIN accounts a ON a.id = m.account_id
     LEFT JOIN accounts mod ON mod.id = m.retracted_by
     WHERE m.topic_id = $1 AND m.type IN ('contribution', 'reply')
       AND m.status IN ('active', 'retracted', 'hidden')
     ORDER BY m.created_at ASC
     LIMIT $2 OFFSET $3`,
    [topicId, limit, offset]
  );

  // Batch-fetch weighted vote sums for all messages
  const messageIds = messages.map(m => m.id);
  const voteMap = {};
  if (messageIds.length > 0) {
    const { rows: voteCounts } = await pool.query(
      `SELECT target_id,
         COALESCE(SUM(weight) FILTER (WHERE value = 'up'), 0)::float AS votes_up,
         COALESCE(SUM(weight) FILTER (WHERE value = 'down'), 0)::float AS votes_down
       FROM votes
       WHERE target_type = 'message' AND target_id = ANY($1)
       GROUP BY target_id`,
      [messageIds]
    );
    for (const vc of voteCounts) voteMap[vc.target_id] = vc;
  }

  // Fetch viewer's own votes if authenticated
  const myVoteMap = {};
  if (viewerAccountId && messageIds.length > 0) {
    const { rows: myVotes } = await pool.query(
      `SELECT target_id, value FROM votes
       WHERE account_id = $1 AND target_type = 'message' AND target_id = ANY($2)`,
      [viewerAccountId, messageIds]
    );
    for (const v of myVotes) myVoteMap[v.target_id] = v.value;
  }

  const now = Date.now();
  for (const msg of messages) {
    // Weighted vote sums, rounded to nearest integer for display
    const vc = voteMap[msg.id];
    msg.votes_up = vc ? Math.round(vc.votes_up) : 0;
    msg.votes_down = vc ? Math.round(vc.votes_down) : 0;
    msg.my_vote = myVoteMap[msg.id] || null;

    // Editable flag (active + owner + within 15min window)
    msg.editable = (
      msg.status === 'active' &&
      viewerAccountId === msg.account_id &&
      now - new Date(msg.created_at).getTime() < MESSAGE_EDIT_WINDOW_MS
    );

    // Redact content for non-active messages
    if (msg.status === 'retracted') {
      msg.content = null;
      msg.redacted_label = 'message retracted';
    } else if (msg.status === 'hidden') {
      msg.content = null;
      msg.redacted_label = msg.hidden_by_name
        ? 'message hidden by ' + msg.hidden_by_name
        : 'message hidden by moderator';
    }
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
 * @param {{ content: string, accountId: string }} params
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
