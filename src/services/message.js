/**
 * Message service — CRUD operations for topic messages with level/type enforcement.
 */

const { getPool } = require('../config/database');
const { analyzeUserInput } = require('./injection-detector');
const { buildPreview } = require('./injection-preview');
const injectionTracker = require('./injection-tracker');
const { MESSAGE_EDIT_WINDOW_MS } = require('../config/protocol');

/**
 * Server-enforced mapping: message type -> level.
 */
const TYPE_LEVEL_MAP = {
  contribution: 1,
  reply: 1,
  edit: 1,
  flag: 1,
  moderation_vote: 1,
  merge: 1,
  revert: 1,
  coordination: 3,
  debug: 3,
  protocol: 3,
};

const MAX_LEVEL_BY_ACCOUNT_TYPE = {
  human: 1,
  ai: 1,
  system: 3,
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

  // Enforce account type vs message level
  const { rows: accRows } = await pool.query(
    'SELECT type FROM accounts WHERE id = $1',
    [accountId]
  );
  if (accRows.length === 0) {
    throw Object.assign(new Error('Account not found'), { code: 'NOT_FOUND' });
  }
  const maxLevel = MAX_LEVEL_BY_ACCOUNT_TYPE[accRows[0].type];
  if (maxLevel === undefined || level > maxLevel) {
    throw Object.assign(
      new Error(`Account type '${accRows[0].type}' cannot post level ${level} messages`),
      { code: 'FORBIDDEN' }
    );
  }

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

  // Check ownership, status, and edit window
  const { rows: existing } = await pool.query(
    'SELECT id, account_id, status, created_at FROM messages WHERE id = $1',
    [id]
  );

  if (existing.length === 0) {
    throw Object.assign(new Error('Message not found'), { code: 'NOT_FOUND' });
  }

  if (existing[0].account_id !== accountId) {
    throw Object.assign(new Error('Only the message author can edit'), { code: 'FORBIDDEN' });
  }

  if (existing[0].status !== 'active') {
    throw Object.assign(new Error('Cannot edit a retracted or hidden message'), { code: 'FORBIDDEN' });
  }

  const editWindowMin = Math.round(MESSAGE_EDIT_WINDOW_MS / 60000);
  if (Date.now() - new Date(existing[0].created_at).getTime() > MESSAGE_EDIT_WINDOW_MS) {
    throw Object.assign(new Error(`Edit window expired (${editWindowMin} minutes after posting)`), { code: 'FORBIDDEN' });
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

/**
 * Retract a message (author soft-delete). Sets status to 'retracted'.
 */
async function retractMessage(id, accountId) {
  const pool = getPool();
  const { rows: existing } = await pool.query(
    'SELECT id, account_id, status FROM messages WHERE id = $1',
    [id]
  );

  if (existing.length === 0) {
    throw Object.assign(new Error('Message not found'), { code: 'NOT_FOUND' });
  }
  if (existing[0].status !== 'active') {
    throw Object.assign(new Error('Message already retracted or hidden'), { code: 'VALIDATION_ERROR' });
  }
  if (existing[0].account_id !== accountId) {
    throw Object.assign(new Error('Only the message author can retract'), { code: 'FORBIDDEN' });
  }

  const { rows } = await pool.query(
    `UPDATE messages SET status = 'retracted', retracted_at = now(), retracted_by = $1
     WHERE id = $2 RETURNING *`,
    [accountId, id]
  );
  return rows[0];
}

/**
 * Hide a message (moderator action). Sets status to 'hidden'.
 * Returns the message with the moderator's name for transparency.
 */
async function hideMessage(id, moderatorAccountId) {
  const pool = getPool();
  const { rows: existing } = await pool.query(
    'SELECT id, status FROM messages WHERE id = $1',
    [id]
  );

  if (existing.length === 0) {
    throw Object.assign(new Error('Message not found'), { code: 'NOT_FOUND' });
  }
  if (existing[0].status !== 'active') {
    throw Object.assign(new Error('Message already retracted or hidden'), { code: 'VALIDATION_ERROR' });
  }

  const { rows } = await pool.query(
    `UPDATE messages m SET status = 'hidden', retracted_at = now(), retracted_by = $1
     WHERE m.id = $2
     RETURNING m.*, (SELECT name FROM accounts WHERE id = $1) AS hidden_by_name`,
    [moderatorAccountId, id]
  );
  return rows[0];
}

module.exports = {
  TYPE_LEVEL_MAP,
  MAX_LEVEL_BY_ACCOUNT_TYPE,
  VALID_TYPES,
  createMessage,
  getMessageById,
  listMessages,
  editMessage,
  retractMessage,
  hideMessage,
  getReplies,
  getMessagesByAccount,
};
