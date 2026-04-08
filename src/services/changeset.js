/**
 * Changeset service — atomic grouped operations on a single topic.
 *
 * A changeset is the unit of review: it groups 1+ operations (add, replace, remove)
 * on chunks within a single topic. Vote, merge, and reject target the changeset,
 * not individual chunks.
 *
 * See: private/CHANGESET-SPEC.md
 */

const { getPool } = require('../config/database');
const trustConfig = require('../config/trust');
const { analyzeContent } = require('./injection-detector');
const {
  T_COMMIT_MS,
  T_REVEAL_MS,
} = require('../config/protocol');

const SYSTEM_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Calculate initial trust score from contributor tier (Beta prior).
 */
function calculateInitialTrust(isElite, hasBadgeContribution) {
  let prior;
  if (isElite) prior = trustConfig.CHUNK_PRIOR_ELITE;
  else if (hasBadgeContribution) prior = trustConfig.CHUNK_PRIOR_ESTABLISHED;
  else prior = trustConfig.CHUNK_PRIOR_NEW;
  return prior[0] / (prior[0] + prior[1]);
}

/**
 * Create a changeset with one or more operations on a single topic.
 *
 * @param {object} params
 * @param {string} params.topicId - Target topic UUID
 * @param {string} params.proposedBy - Account UUID of the proposer
 * @param {string} [params.description] - Human-readable description of the changeset
 * @param {Array} params.operations - Array of operation objects
 * @param {boolean} [params.isElite] - Proposer has elite badge
 * @param {boolean} [params.hasBadgeContribution] - Proposer has contribution badge
 * @returns {{ changeset: object, operations: Array<{operation: string, chunkId: string|null, targetChunkId: string|null}> }}
 */
async function createChangeset({ topicId, proposedBy, description, operations, isElite = false, hasBadgeContribution = false }) {
  const pool = getPool();
  const client = await pool.connect();

  // --- Validation ---
  if (!operations || operations.length === 0) {
    throw Object.assign(
      new Error('At least one operation is required'),
      { code: 'VALIDATION_ERROR' }
    );
  }

  for (const op of operations) {
    if (!['add', 'replace', 'remove'].includes(op.operation)) {
      throw Object.assign(
        new Error(`Invalid operation type: ${op.operation}`),
        { code: 'VALIDATION_ERROR' }
      );
    }
    if ((op.operation === 'add' || op.operation === 'replace') && !op.content) {
      throw Object.assign(
        new Error(`Content is required for '${op.operation}' operations`),
        { code: 'VALIDATION_ERROR' }
      );
    }
    if ((op.operation === 'replace' || op.operation === 'remove') && !op.targetChunkId) {
      throw Object.assign(
        new Error(`targetChunkId is required for '${op.operation}' operations`),
        { code: 'VALIDATION_ERROR' }
      );
    }
  }

  // Validate targetChunkIds: must be published and belong to the same topic
  const targetChunkIds = operations
    .filter(op => op.targetChunkId)
    .map(op => op.targetChunkId);

  if (targetChunkIds.length > 0) {
    const { rows: targetChunks } = await pool.query(
      `SELECT c.id, c.status, ct.topic_id
       FROM chunks c
       JOIN chunk_topics ct ON ct.chunk_id = c.id
       WHERE c.id = ANY($1)`,
      [targetChunkIds]
    );

    const foundIds = new Set(targetChunks.map(r => r.id));
    for (const id of targetChunkIds) {
      if (!foundIds.has(id)) {
        throw Object.assign(
          new Error(`Target chunk not found: ${id}`),
          { code: 'NOT_FOUND' }
        );
      }
    }

    for (const tc of targetChunks) {
      if (tc.status !== 'published') {
        throw Object.assign(
          new Error(`Target chunk ${tc.id} is not published (status: ${tc.status})`),
          { code: 'VALIDATION_ERROR' }
        );
      }
      if (tc.topic_id !== topicId) {
        throw Object.assign(
          new Error(`Target chunk ${tc.id} belongs to a different topic`),
          { code: 'VALIDATION_ERROR' }
        );
      }
    }
  }

  // --- Run injection analysis on each new chunk content ---
  const injectionResults = operations.map(op => {
    if (op.operation === 'add' || op.operation === 'replace') {
      return analyzeContent(op.content);
    }
    return null;
  });

  // --- Transaction ---
  try {
    await client.query('BEGIN');

    // 1. INSERT changeset
    const { rows: csRows } = await client.query(
      `INSERT INTO changesets (topic_id, proposed_by, description, status)
       VALUES ($1, $2, $3, 'proposed')
       RETURNING *`,
      [topicId, proposedBy, description || null]
    );
    const changeset = csRows[0];

    // 2. Process each operation
    const resultOps = [];

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      const injectionResult = injectionResults[i];

      if (op.operation === 'add') {
        // Create a new chunk with status='proposed'
        const { rows: chunkRows } = await client.query(
          `INSERT INTO chunks (content, technical_detail, has_technical_detail, created_by, trust_score,
                               title, subtitle, status,
                               injection_risk_score, injection_flags)
           VALUES ($1, $2, $3, $4, 0, $5, $6, 'proposed', $7, $8)
           RETURNING *`,
          [
            op.content,
            op.technicalDetail || null,
            op.technicalDetail != null,
            proposedBy,
            op.title || null,
            op.subtitle || null,
            injectionResult ? injectionResult.score : 0,
            injectionResult && injectionResult.flags.length > 0 ? injectionResult.flags : null,
          ]
        );
        const chunk = chunkRows[0];

        // Link chunk to topic
        await client.query(
          'INSERT INTO chunk_topics (chunk_id, topic_id) VALUES ($1, $2)',
          [chunk.id, topicId]
        );

        // Link in changeset_operations
        await client.query(
          `INSERT INTO changeset_operations (changeset_id, operation, chunk_id, sort_order)
           VALUES ($1, 'add', $2, $3)`,
          [changeset.id, chunk.id, i]
        );

        resultOps.push({ operation: 'add', chunkId: chunk.id, targetChunkId: null });

      } else if (op.operation === 'replace') {
        // Get target chunk version for incrementing
        const { rows: targetRows } = await client.query(
          'SELECT version FROM chunks WHERE id = $1',
          [op.targetChunkId]
        );
        const newVersion = (targetRows[0]?.version || 1) + 1;

        // Create new chunk with parent_chunk_id
        const { rows: chunkRows } = await client.query(
          `INSERT INTO chunks (content, technical_detail, has_technical_detail, created_by, trust_score,
                               title, subtitle, status, version, parent_chunk_id,
                               injection_risk_score, injection_flags)
           VALUES ($1, $2, $3, $4, 0, $5, $6, 'proposed', $7, $8, $9, $10)
           RETURNING *`,
          [
            op.content,
            op.technicalDetail || null,
            op.technicalDetail != null,
            proposedBy,
            op.title || null,
            op.subtitle || null,
            newVersion,
            op.targetChunkId,
            injectionResult ? injectionResult.score : 0,
            injectionResult && injectionResult.flags.length > 0 ? injectionResult.flags : null,
          ]
        );
        const chunk = chunkRows[0];

        // Link chunk to topic
        await client.query(
          'INSERT INTO chunk_topics (chunk_id, topic_id) VALUES ($1, $2)',
          [chunk.id, topicId]
        );

        // Link in changeset_operations with both chunk_id and target_chunk_id
        await client.query(
          `INSERT INTO changeset_operations (changeset_id, operation, chunk_id, target_chunk_id, sort_order)
           VALUES ($1, 'replace', $2, $3, $4)`,
          [changeset.id, chunk.id, op.targetChunkId, i]
        );

        resultOps.push({ operation: 'replace', chunkId: chunk.id, targetChunkId: op.targetChunkId });

      } else if (op.operation === 'remove') {
        // No new chunk, just record the operation
        await client.query(
          `INSERT INTO changeset_operations (changeset_id, operation, target_chunk_id, sort_order)
           VALUES ($1, 'remove', $2, $3)`,
          [changeset.id, op.targetChunkId, i]
        );

        resultOps.push({ operation: 'remove', chunkId: null, targetChunkId: op.targetChunkId });
      }
    }

    // Activity log
    const activityMeta = { topicId, operationCount: operations.length };
    const hasSuspicious = injectionResults.some(r => r && r.suspicious);
    if (hasSuspicious) {
      activityMeta.injection_flagged = true;
    }
    await client.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, 'changeset', $3, $4)`,
      [proposedBy, hasSuspicious ? 'changeset_injection_flagged' : 'changeset_proposed', changeset.id, JSON.stringify(activityMeta)]
    );

    await client.query('COMMIT');

    return { changeset, operations: resultOps };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get a changeset by ID with its operations and chunk content.
 */
async function getChangesetById(changesetId) {
  const pool = getPool();

  const { rows: csRows } = await pool.query(
    'SELECT * FROM changesets WHERE id = $1',
    [changesetId]
  );
  if (csRows.length === 0) {
    return null;
  }
  const changeset = csRows[0];

  const { rows: ops } = await pool.query(
    `SELECT co.*,
            c.content, c.technical_detail, c.title, c.subtitle, c.status AS chunk_status,
            c.version, c.parent_chunk_id,
            tc.content AS target_content, tc.title AS target_title, tc.subtitle AS target_subtitle
     FROM changeset_operations co
     LEFT JOIN chunks c ON c.id = co.chunk_id
     LEFT JOIN chunks tc ON tc.id = co.target_chunk_id
     WHERE co.changeset_id = $1
     ORDER BY co.sort_order`,
    [changesetId]
  );

  changeset.operations = ops;
  return changeset;
}

/**
 * Merge a changeset: atomically publish add/replace chunks, supersede targets, handle removes.
 *
 * @param {string} changesetId
 * @param {string} mergedById - Account UUID of the merger
 * @returns {object} The merged changeset
 */
async function mergeChangeset(changesetId, mergedById) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch changeset
    const { rows: csRows } = await client.query(
      "SELECT * FROM changesets WHERE id = $1 AND status IN ('proposed', 'under_review') FOR UPDATE",
      [changesetId]
    );
    if (csRows.length === 0) {
      const { rows: exists } = await client.query('SELECT status FROM changesets WHERE id = $1', [changesetId]);
      if (exists.length === 0) {
        throw Object.assign(new Error('Changeset not found'), { code: 'NOT_FOUND' });
      }
      throw Object.assign(
        new Error(`Cannot merge changeset in '${exists[0].status}' status`),
        { code: 'INVALID_TRANSITION' }
      );
    }
    const changeset = csRows[0];

    // Calculate initial trust score from proposer's prior
    const { rows: proposerRows } = await client.query(
      'SELECT badge_elite, badge_contribution FROM accounts WHERE id = $1',
      [changeset.proposed_by]
    );
    const proposer = proposerRows[0] || {};
    const initialTrust = calculateInitialTrust(proposer.badge_elite, proposer.badge_contribution);

    // Fetch operations
    const { rows: ops } = await client.query(
      'SELECT * FROM changeset_operations WHERE changeset_id = $1 ORDER BY sort_order',
      [changesetId]
    );

    for (const op of ops) {
      if (op.operation === 'add') {
        // Publish the new chunk
        await client.query(
          `UPDATE chunks SET status = 'published', trust_score = $2,
                  merged_at = now(), merged_by = $3, updated_at = now()
           WHERE id = $1`,
          [op.chunk_id, initialTrust, mergedById]
        );

      } else if (op.operation === 'replace') {
        // Publish the new chunk
        await client.query(
          `UPDATE chunks SET status = 'published', trust_score = $2,
                  merged_at = now(), merged_by = $3, updated_at = now()
           WHERE id = $1`,
          [op.chunk_id, initialTrust, mergedById]
        );

        // Supersede the target chunk
        await client.query(
          `UPDATE chunks SET status = 'superseded', superseded_by = $2, updated_at = now()
           WHERE id = $1 AND status = 'published'`,
          [op.target_chunk_id, op.chunk_id]
        );

      } else if (op.operation === 'remove') {
        // Supersede the target chunk
        await client.query(
          `UPDATE chunks SET status = 'superseded', updated_at = now()
           WHERE id = $1 AND status = 'published'`,
          [op.target_chunk_id]
        );
      }
    }

    // Update changeset
    const { rows: mergedRows } = await client.query(
      `UPDATE changesets SET status = 'published', merged_at = now(), merged_by = $2,
              initial_trust_score = $3, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [changesetId, mergedById, initialTrust]
    );

    // Activity log
    await client.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES ($1, 'changeset_merged', 'changeset', $2, $3)`,
      [mergedById, changesetId, JSON.stringify({ operationCount: ops.length })]
    );

    await client.query('COMMIT');

    return mergedRows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reject a changeset: retract all new chunks, mark changeset as retracted.
 *
 * @param {string} changesetId
 * @param {object} params
 * @param {string} [params.reason] - Rejection reason
 * @param {string} [params.category] - Rejection category
 * @param {string} [params.suggestions] - Improvement suggestions
 * @param {string} params.rejectedBy - Account UUID
 * @returns {object} The rejected changeset
 */
async function rejectChangeset(changesetId, { reason, category, suggestions, rejectedBy }) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch changeset
    const { rows: csRows } = await client.query(
      "SELECT * FROM changesets WHERE id = $1 AND status IN ('proposed', 'under_review') FOR UPDATE",
      [changesetId]
    );
    if (csRows.length === 0) {
      const { rows: exists } = await client.query('SELECT status FROM changesets WHERE id = $1', [changesetId]);
      if (exists.length === 0) {
        throw Object.assign(new Error('Changeset not found'), { code: 'NOT_FOUND' });
      }
      throw Object.assign(
        new Error(`Cannot reject changeset in '${exists[0].status}' status`),
        { code: 'INVALID_TRANSITION' }
      );
    }

    // Retract all new chunks (from add/replace operations)
    await client.query(
      `UPDATE chunks SET status = 'retracted', updated_at = now()
       WHERE id IN (
         SELECT chunk_id FROM changeset_operations
         WHERE changeset_id = $1 AND chunk_id IS NOT NULL
       )`,
      [changesetId]
    );

    // Update changeset
    const { rows: rejectedRows } = await client.query(
      `UPDATE changesets SET status = 'retracted', rejected_by = $2,
              reject_reason = $3, rejection_category = $4, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [changesetId, rejectedBy, reason || null, category || null]
    );

    // Activity log
    await client.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES ($1, 'changeset_rejected', 'changeset', $2, $3)`,
      [rejectedBy, changesetId, JSON.stringify({ reason: reason || null, category: category || null })]
    );

    await client.query('COMMIT');

    return rejectedRows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retract a changeset (author-initiated withdrawal).
 *
 * @param {string} changesetId
 * @param {string} accountId - Must be the proposer
 * @returns {object} The retracted changeset
 */
async function retractChangeset(changesetId, accountId) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch changeset
    const { rows: csRows } = await client.query(
      'SELECT * FROM changesets WHERE id = $1 FOR UPDATE',
      [changesetId]
    );
    if (csRows.length === 0) {
      throw Object.assign(new Error('Changeset not found'), { code: 'NOT_FOUND' });
    }
    const changeset = csRows[0];

    // Validate ownership
    if (changeset.proposed_by !== accountId) {
      throw Object.assign(
        new Error('Only the proposer can retract a changeset'),
        { code: 'FORBIDDEN' }
      );
    }

    // Validate status
    if (!['proposed', 'under_review'].includes(changeset.status)) {
      throw Object.assign(
        new Error(`Cannot retract changeset in '${changeset.status}' status`),
        { code: 'INVALID_TRANSITION' }
      );
    }

    // Retract all new chunks
    await client.query(
      `UPDATE chunks SET status = 'retracted', updated_at = now()
       WHERE id IN (
         SELECT chunk_id FROM changeset_operations
         WHERE changeset_id = $1 AND chunk_id IS NOT NULL
       )`,
      [changesetId]
    );

    // Update changeset: retract and cancel any active vote
    const { rows: retractedRows } = await client.query(
      `UPDATE changesets SET status = 'retracted', retract_reason = 'author_retracted',
              vote_phase = NULL, commit_deadline_at = NULL, reveal_deadline_at = NULL,
              updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [changesetId]
    );

    // Activity log
    await client.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES ($1, 'changeset_retracted', 'changeset', $2, $3)`,
      [accountId, changesetId, JSON.stringify({ reason: 'author_retracted' })]
    );

    await client.query('COMMIT');

    return retractedRows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resubmit a retracted changeset (author-initiated).
 *
 * @param {string} changesetId
 * @param {string} accountId - Must be the proposer
 * @returns {object} The resubmitted changeset
 */
async function resubmitChangeset(changesetId, accountId) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch changeset
    const { rows: csRows } = await client.query(
      'SELECT * FROM changesets WHERE id = $1 FOR UPDATE',
      [changesetId]
    );
    if (csRows.length === 0) {
      throw Object.assign(new Error('Changeset not found'), { code: 'NOT_FOUND' });
    }
    const changeset = csRows[0];

    // Validate ownership
    if (changeset.proposed_by !== accountId) {
      throw Object.assign(
        new Error('Only the proposer can resubmit a changeset'),
        { code: 'FORBIDDEN' }
      );
    }

    // Validate status
    if (changeset.status !== 'retracted') {
      throw Object.assign(
        new Error(`Cannot resubmit changeset in '${changeset.status}' status (must be retracted)`),
        { code: 'INVALID_TRANSITION' }
      );
    }

    // Set all new chunks back to proposed
    await client.query(
      `UPDATE chunks SET status = 'proposed', updated_at = now()
       WHERE id IN (
         SELECT chunk_id FROM changeset_operations
         WHERE changeset_id = $1 AND chunk_id IS NOT NULL
       )`,
      [changesetId]
    );

    // Update changeset: clear reject/retract fields
    const { rows: resubmittedRows } = await client.query(
      `UPDATE changesets SET status = 'proposed',
              rejected_by = NULL, reject_reason = NULL, rejection_category = NULL,
              retract_reason = NULL, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [changesetId]
    );

    // Activity log
    await client.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id)
       VALUES ($1, 'changeset_resubmitted', 'changeset', $2)`,
      [accountId, changesetId]
    );

    await client.query('COMMIT');

    return resubmittedRows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Escalate a changeset to formal review (object).
 * Sets status to under_review and configures commit/reveal deadlines.
 *
 * NOTE: Does NOT call formalVoteService.startCommitPhase -- that will be adapted later
 * to work with changesets. Fields are set directly here.
 *
 * @param {string} changesetId
 * @param {string} escalatedBy - Account UUID
 * @returns {object} The escalated changeset
 */
async function escalateToReview(changesetId, escalatedBy) {
  const pool = getPool();

  const commitDeadline = new Date(Date.now() + T_COMMIT_MS);
  const revealDeadline = new Date(commitDeadline.getTime() + T_REVEAL_MS);

  // Atomic: only escalate if currently proposed
  const { rows } = await pool.query(
    `UPDATE changesets SET status = 'under_review', under_review_at = now(),
            vote_phase = 'commit', commit_deadline_at = $2, reveal_deadline_at = $3,
            updated_at = now()
     WHERE id = $1 AND status = 'proposed'
     RETURNING *`,
    [changesetId, commitDeadline, revealDeadline]
  );

  if (rows.length === 0) {
    const { rows: exists } = await pool.query('SELECT status FROM changesets WHERE id = $1', [changesetId]);
    if (exists.length === 0) {
      throw Object.assign(new Error('Changeset not found'), { code: 'NOT_FOUND' });
    }
    throw Object.assign(
      new Error(`Cannot escalate changeset in '${exists[0].status}' status (must be proposed)`),
      { code: 'INVALID_TRANSITION' }
    );
  }

  // Activity log
  await pool.query(
    `INSERT INTO activity_log (account_id, action, target_type, target_id)
     VALUES ($1, 'changeset_escalated', 'changeset', $2)`,
    [escalatedBy, changesetId]
  );

  return rows[0];
}

/**
 * List pending changesets (proposed or under_review) with topic/proposer info.
 *
 * @param {object} params
 * @param {number} [params.page=1]
 * @param {number} [params.limit=20]
 * @returns {{ data: Array, pagination: { page: number, limit: number, total: number } }}
 */
async function listPendingChangesets({ page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const [countResult, dataResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM changesets
       WHERE status IN ('proposed', 'under_review')`
    ),
    pool.query(
      `SELECT cs.*,
              t.title AS topic_title, t.slug AS topic_slug,
              a.name AS proposed_by_name,
              (SELECT COUNT(*)::int FROM changeset_operations WHERE changeset_id = cs.id) AS operation_count
       FROM changesets cs
       JOIN topics t ON t.id = cs.topic_id
       JOIN accounts a ON a.id = cs.proposed_by
       WHERE cs.status IN ('proposed', 'under_review')
       ORDER BY cs.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
  ]);

  const total = countResult.rows[0].total;

  return {
    data: dataResult.rows,
    pagination: { page, limit, total },
  };
}

module.exports = {
  createChangeset,
  getChangesetById,
  mergeChangeset,
  rejectChangeset,
  retractChangeset,
  resubmitChangeset,
  escalateToReview,
  listPendingChangesets,
  SYSTEM_ACCOUNT_ID,
};
