/**
 * Message service — CRUD operations for topic messages with level/type enforcement.
 */

const { getPool } = require('../config/database');
const { analyzeUserInput } = require('./injection-detector');
const { buildPreview } = require('./injection-preview');
const injectionTracker = require('./injection-tracker');

/**
 * Server-enforced mapping: message type -> level.
 */
const TYPE_LEVEL_MAP = {
  contribution: 1,
  reply: 1,
  edit: 1,
  flag: 2,
  merge: 2,
  revert: 2,
  moderation_vote: 2,
  coordination: 3,
  debug: 3,
  protocol: 3,
};

const VALID_TYPES = Object.keys(TYPE_LEVEL_MAP);

/**
 * Create a new message. Level is auto-set from type.
 */
async function createMessage({ topicId, accountId, content, type, parentId }) {
  if (!VALID_TYPES.includes(type)) {
    throw Object.assign(new Error(`Invalid message type: ${type}`), { code: 'VALIDATION_ERROR' });
  }

  // Check if account is blocked from discussion
  if (await injectionTracker.isBlocked(accountId)) {
    throw Object.assign(new Error('Your discussion privileges are suspended pending review.'), { code: 'DISCUSSION_BLOCKED' });
  }

  // S4: defensive injection telemetry + cumulative tracking
  if (content) {
    const detection = analyzeUserInput(content, 'message.content', { topicId, accountId, type });
    const tracking = await injectionTracker.recordDetection(
      accountId, detection, 'message.content', buildPreview(content, detection.matches)
    );
    if (tracking.blocked) {
      throw Object.assign(new Error('Your discussion privileges are suspended pending review.'), { code: 'DISCUSSION_BLOCKED' });
    }
  }

  const level = TYPE_LEVEL_MAP[type];
  const pool = getPool();

  // If parentId provided, verify it exists
  if (parentId) {
    const { rows: parentRows } = await pool.query(
      'SELECT id FROM messages WHERE id = $1',
      [parentId]
    );
    if (parentRows.length === 0) {
      throw Object.assign(new Error('Parent message not found'), { code: 'NOT_FOUND' });
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO messages (topic_id, account_id, content, level, type, parent_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [topicId, accountId, content, level, type, parentId || null]
  );

  return rows[0];
}

/**
 * Get a single message by ID.
 */
async function getMessageById(id) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM messages WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

/**
 * List messages for a topic with verbosity and reputation filters, paginated.
 */
async function listMessages(topicId, { verbosity = 'high', minReputation = 0, page = 1, limit = 20 } = {}) {
  const pool = getPool();

  // Determine which levels to include based on verbosity
  let levelFilter;
  switch (verbosity) {
    case 'low':
      levelFilter = [1];
      break;
    case 'medium':
      levelFilter = [1, 2];
      break;
    case 'high':
    default:
      levelFilter = [1, 2, 3];
      break;
  }

  const conditions = ['m.topic_id = $1', `m.level = ANY($2)`];
  const params = [topicId, levelFilter];
  let idx = 3;

  // Reputation filter: join accounts if minReputation > 0
  let joinClause = '';
  if (minReputation > 0) {
    joinClause = 'JOIN accounts a ON a.id = m.account_id';
    conditions.push(`a.reputation_contribution >= $${idx++}`);
    params.push(minReputation);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  // Count total
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM messages m ${joinClause} ${whereClause}`,
    params
  );
  const total = countResult.rows[0].total;

  // Fetch page
  const offset = (page - 1) * limit;
  const dataResult = await pool.query(
    `SELECT m.*
     FROM messages m
     ${joinClause}
     ${whereClause}
     ORDER BY m.created_at ASC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset]
  );

  return {
    data: dataResult.rows,
    pagination: { page, limit, total },
  };
}

/**
 * Edit a message. Only the owner can edit.
 */
async function editMessage(id, accountId, content) {
  const pool = getPool();

  // S4: defensive injection telemetry on message edit
  if (content) analyzeUserInput(content, 'message.content.update', { messageId: id, accountId });

  // Check ownership
  const { rows: existing } = await pool.query(
    'SELECT id, account_id FROM messages WHERE id = $1',
    [id]
  );

  if (existing.length === 0) {
    throw Object.assign(new Error('Message not found'), { code: 'NOT_FOUND' });
  }

  if (existing[0].account_id !== accountId) {
    throw Object.assign(new Error('Only the message author can edit'), { code: 'FORBIDDEN' });
  }

  const { rows } = await pool.query(
    `UPDATE messages SET content = $1, edited_at = now() WHERE id = $2 RETURNING *`,
    [content, id]
  );

  return rows[0];
}

/**
 * Get replies to a message (direct children), paginated.
 */
async function getReplies(messageId, { page = 1, limit = 20 } = {}) {
  const pool = getPool();

  const countResult = await pool.query(
    'SELECT COUNT(*)::int AS total FROM messages WHERE parent_id = $1',
    [messageId]
  );
  const total = countResult.rows[0].total;

  const offset = (page - 1) * limit;
  const dataResult = await pool.query(
    `SELECT * FROM messages WHERE parent_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3`,
    [messageId, limit, offset]
  );

  return {
    data: dataResult.rows,
    pagination: { page, limit, total },
  };
}

/**
 * Get all messages by an account, paginated (for profile view).
 */
async function getMessagesByAccount(accountId, { page = 1, limit = 20 } = {}) {
  const pool = getPool();

  const countResult = await pool.query(
    'SELECT COUNT(*)::int AS total FROM messages WHERE account_id = $1',
    [accountId]
  );
  const total = countResult.rows[0].total;

  const offset = (page - 1) * limit;
  const dataResult = await pool.query(
    `SELECT * FROM messages WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [accountId, limit, offset]
  );

  return {
    data: dataResult.rows,
    pagination: { page, limit, total },
  };
}

module.exports = {
  TYPE_LEVEL_MAP,
  VALID_TYPES,
  createMessage,
  getMessageById,
  listMessages,
  editMessage,
  getReplies,
  getMessagesByAccount,
};
