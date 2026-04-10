/**
 * Dispute service — file and resolve disputes on published chunks.
 * Uses domain/lifecycle for state transitions.
 */

const { getPool } = require('../config/database');
const { transition, retractReasonForEvent } = require('../domain');
const { OBJECTION_REASON_TAGS } = require('../config/protocol');
const { analyzeUserInput } = require('./injection-detector');

const VALID_REASON_TAGS = [...OBJECTION_REASON_TAGS];
const VALID_VERDICTS = ['upheld', 'removed'];

/**
 * File a dispute on a published chunk.
 * Transitions: published → disputed
 */
async function fileDispute(chunkId, { disputedBy, reason, reasonTag }) {
  if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
    const err = new Error('reason is required (minimum 10 characters)');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  if (!reasonTag || !VALID_REASON_TAGS.includes(reasonTag)) {
    const err = new Error(`reasonTag must be one of: ${VALID_REASON_TAGS.join(', ')}`);
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  // S4: defensive injection telemetry on dispute reason
  analyzeUserInput(reason, 'dispute.reason', { chunkId, disputedBy });

  const pool = getPool();

  // Atomic transition: only update if currently active
  const { rows } = await pool.query(
    `UPDATE chunks SET status = 'disputed', disputed_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'published'
     RETURNING *`,
    [chunkId]
  );

  if (rows.length === 0) {
    const { rows: exists } = await pool.query('SELECT status FROM chunks WHERE id = $1', [chunkId]);
    if (exists.length === 0) {
      throw Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' });
    }
    // Will throw LifecycleError with proper message
    transition(exists[0].status, 'DISPUTE');
  }

  // Log activity
  await pool.query(
    `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
     VALUES ($1, 'chunk_disputed', 'chunk', $2, $3)`,
    [disputedBy, chunkId, JSON.stringify({ reason: reason.trim(), reasonTag })]
  );

  return rows[0];
}

/**
 * Resolve a dispute.
 * verdict 'upheld' → disputed → published (content stays)
 * verdict 'removed' → disputed → retracted (content removed)
 */
async function resolveDispute(chunkId, { resolvedBy, verdict, notes }) {
  if (!VALID_VERDICTS.includes(verdict)) {
    const err = new Error(`verdict must be one of: ${VALID_VERDICTS.join(', ')}`);
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const pool = getPool();
  const event = verdict === 'upheld' ? 'DISPUTE_UPHELD' : 'DISPUTE_REMOVED';

  if (verdict === 'upheld') {
    // disputed → active
    const { rows } = await pool.query(
      `UPDATE chunks SET status = 'published', disputed_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'disputed'
       RETURNING *`,
      [chunkId]
    );

    if (rows.length === 0) {
      const { rows: exists } = await pool.query('SELECT status FROM chunks WHERE id = $1', [chunkId]);
      if (exists.length === 0) {
        throw Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' });
      }
      transition(exists[0].status, event);
    }

    await pool.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES ($1, 'dispute_upheld', 'chunk', $2, $3)`,
      [resolvedBy, chunkId, JSON.stringify({ notes: notes || null })]
    );

    return rows[0];
  } else {
    // disputed → retracted
    const retractReason = retractReasonForEvent(event) || 'rejected';

    const { rows } = await pool.query(
      `UPDATE chunks SET status = 'retracted', retract_reason = $2, disputed_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'disputed'
       RETURNING *`,
      [chunkId, retractReason]
    );

    if (rows.length === 0) {
      const { rows: exists } = await pool.query('SELECT status FROM chunks WHERE id = $1', [chunkId]);
      if (exists.length === 0) {
        throw Object.assign(new Error('Chunk not found'), { code: 'NOT_FOUND' });
      }
      transition(exists[0].status, event);
    }

    await pool.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES ($1, 'dispute_removed', 'chunk', $2, $3)`,
      [resolvedBy, chunkId, JSON.stringify({ retractReason, notes: notes || null })]
    );

    return rows[0];
  }
}

/**
 * List disputed chunks (for review queue).
 */
async function listDisputed({ page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const countResult = await pool.query(
    "SELECT COUNT(*)::int AS total FROM chunks WHERE status = 'disputed'"
  );
  const total = countResult.rows[0].total;

  const dataResult = await pool.query(
    `SELECT c.*, ct.topic_id,
       t.title AS topic_title,
       a.action AS dispute_action, a.metadata AS dispute_metadata, a.created_at AS disputed_by_at
     FROM chunks c
     JOIN chunk_topics ct ON ct.chunk_id = c.id
     JOIN topics t ON t.id = ct.topic_id
     LEFT JOIN activity_log a ON a.target_id = c.id AND a.action = 'chunk_disputed'
     WHERE c.status = 'disputed'
     ORDER BY c.disputed_at ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return {
    data: dataResult.rows,
    pagination: { page, limit, total },
  };
}

module.exports = {
  fileDispute,
  resolveDispute,
  listDisputed,
  VALID_REASON_TAGS,
  VALID_VERDICTS,
};
