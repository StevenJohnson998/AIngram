/**
 * Refresh service — article freshness mechanism.
 * Handles chunk flagging, refresh changeset submission, queue management.
 * Design: private/REFRESH-DESIGN.md
 */

const { getPool } = require('../config/database');
const {
  AGE_GRACE_DAYS,
  DECAY_DAYS,
  FLAG_WEIGHT,
  FLAG_PLATEAU,
  VALID_OPERATIONS,
  VALID_GLOBAL_VERDICTS,
} = require('../config/refresh');

/**
 * Flag a chunk for refresh.
 * Inserts a pending flag; the DB trigger sets topics.to_be_refreshed = TRUE.
 */
async function flagChunk(chunkId, accountId, reason, evidence = null) {
  const pool = getPool();

  // Validate chunk exists and belongs to a knowledge topic
  const { rows: chunkRows } = await pool.query(
    `SELECT c.id, t.topic_type
     FROM chunks c
     JOIN chunk_topics ct ON ct.chunk_id = c.id
     JOIN topics t ON t.id = ct.topic_id
     WHERE c.id = $1 AND c.status = 'published' AND c.hidden = false`,
    [chunkId]
  );
  if (chunkRows.length === 0) {
    throw Object.assign(new Error('Chunk not found or not published'), { code: 'NOT_FOUND' });
  }
  if (chunkRows[0].topic_type !== 'knowledge') {
    throw Object.assign(
      new Error('Refresh flags are only supported on knowledge topics'),
      { code: 'VALIDATION_ERROR' }
    );
  }

  const { rows } = await pool.query(
    `INSERT INTO chunk_refresh_flags (chunk_id, flagged_by, reason, evidence)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [chunkId, accountId, reason, evidence ? JSON.stringify(evidence) : null]
  );

  return rows[0];
}

/**
 * Get pending refresh flags for a topic, grouped by chunk.
 */
async function getTopicRefreshFlags(topicId) {
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT crf.*, c.content AS chunk_content_preview
     FROM chunk_refresh_flags crf
     JOIN chunks c ON c.id = crf.chunk_id
     JOIN chunk_topics ct ON ct.chunk_id = c.id
     WHERE ct.topic_id = $1 AND crf.status = 'pending'
     ORDER BY crf.flagged_at ASC`,
    [topicId]
  );

  // Group by chunk_id
  const byChunk = {};
  for (const flag of rows) {
    if (!byChunk[flag.chunk_id]) {
      byChunk[flag.chunk_id] = {
        chunk_id: flag.chunk_id,
        chunk_content_preview: flag.chunk_content_preview
          ? flag.chunk_content_preview.substring(0, 200)
          : null,
        flags: [],
      };
    }
    const { chunk_content_preview, ...flagData } = flag;
    byChunk[flag.chunk_id].flags.push(flagData);
  }

  return Object.values(byChunk);
}

/**
 * Submit a refresh changeset for a topic.
 * Validates that every published chunk has an operation (verify/update/flag).
 * Atomic transaction: applies ops, resolves flags, updates topic, awards reputation.
 */
async function submitRefresh(topicId, accountId, operations, globalVerdict) {
  const pool = getPool();

  // Validate globalVerdict
  if (!VALID_GLOBAL_VERDICTS.includes(globalVerdict)) {
    throw Object.assign(
      new Error(`globalVerdict must be one of: ${VALID_GLOBAL_VERDICTS.join(', ')}`),
      { code: 'VALIDATION_ERROR' }
    );
  }

  // Validate operations
  if (!Array.isArray(operations) || operations.length === 0) {
    throw Object.assign(new Error('Operations array is required'), { code: 'VALIDATION_ERROR' });
  }

  for (const op of operations) {
    if (!op.chunk_id || !op.op) {
      throw Object.assign(
        new Error('Each operation must have chunk_id and op'),
        { code: 'VALIDATION_ERROR' }
      );
    }
    if (!VALID_OPERATIONS.includes(op.op)) {
      throw Object.assign(
        new Error(`Invalid operation: ${op.op}. Must be one of: ${VALID_OPERATIONS.join(', ')}`),
        { code: 'VALIDATION_ERROR' }
      );
    }
    if (op.op === 'update' && !op.new_content) {
      throw Object.assign(
        new Error('new_content is required for update operations'),
        { code: 'VALIDATION_ERROR' }
      );
    }
  }

  // Check topic exists and is knowledge type
  const { rows: topicRows } = await pool.query(
    'SELECT id, topic_type FROM topics WHERE id = $1',
    [topicId]
  );
  if (topicRows.length === 0) {
    throw Object.assign(new Error('Topic not found'), { code: 'NOT_FOUND' });
  }
  if (topicRows[0].topic_type !== 'knowledge') {
    throw Object.assign(
      new Error('Refresh is only supported on knowledge topics'),
      { code: 'VALIDATION_ERROR' }
    );
  }

  // Get all published chunks for this topic
  const { rows: topicChunks } = await pool.query(
    `SELECT c.id
     FROM chunks c
     JOIN chunk_topics ct ON ct.chunk_id = c.id
     WHERE ct.topic_id = $1 AND c.status = 'published' AND c.hidden = false
     ORDER BY c.created_at ASC`,
    [topicId]
  );

  const requiredChunkIds = new Set(topicChunks.map(c => c.id));
  const providedChunkIds = new Set(operations.map(op => op.chunk_id));

  // Validate coverage: every chunk must have an operation
  for (const requiredId of requiredChunkIds) {
    if (!providedChunkIds.has(requiredId)) {
      throw Object.assign(
        new Error(`Missing operation for chunk ${requiredId}. All published chunks must be covered.`),
        { code: 'INCOMPLETE_COVERAGE' }
      );
    }
  }

  // Validate no extraneous chunks
  for (const providedId of providedChunkIds) {
    if (!requiredChunkIds.has(providedId)) {
      throw Object.assign(
        new Error(`Chunk ${providedId} is not a published chunk of this topic`),
        { code: 'VALIDATION_ERROR' }
      );
    }
  }

  // Begin atomic transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create a refresh record in activity_log
    const { rows: logRows } = await client.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES ($1, 'article_refreshed', 'topic', $2, $3)
       RETURNING id`,
      [accountId, topicId, JSON.stringify({ globalVerdict, operationCount: operations.length })]
    );
    const activityLogId = logRows[0].id;

    let hasNewFlags = false;
    const verifyCount = operations.filter(op => op.op === 'verify').length;
    const updateCount = operations.filter(op => op.op === 'update').length;

    // Process each operation
    for (const op of operations) {
      if (op.op === 'verify') {
        // Log verification (no chunk modification)
        await client.query(
          `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
           VALUES ($1, 'chunk_verified', 'chunk', $2, $3)`,
          [accountId, op.chunk_id, JSON.stringify({ evidence: op.evidence || null })]
        );
      } else if (op.op === 'update') {
        // Update the chunk content
        await client.query(
          `UPDATE chunks SET content = $1, updated_at = NOW() WHERE id = $2`,
          [op.new_content, op.chunk_id]
        );
        await client.query(
          `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
           VALUES ($1, 'chunk_refresh_updated', 'chunk', $2, $3)`,
          [accountId, op.chunk_id, JSON.stringify({ evidence: op.evidence || null })]
        );
      } else if (op.op === 'flag') {
        // The agent escalates: insert a new pending flag
        await client.query(
          `INSERT INTO chunk_refresh_flags (chunk_id, flagged_by, reason, evidence)
           VALUES ($1, $2, $3, $4)`,
          [op.chunk_id, accountId, op.reason || 'Flagged during refresh', op.evidence ? JSON.stringify(op.evidence) : null]
        );
        hasNewFlags = true;
      }
    }

    // Resolve pending flags for chunks that got verify or update operations
    const addressedChunkIds = operations
      .filter(op => op.op === 'verify' || op.op === 'update')
      .map(op => op.chunk_id);

    if (addressedChunkIds.length > 0) {
      await client.query(
        `UPDATE chunk_refresh_flags
         SET status = 'addressed', addressed_at = NOW()
         WHERE chunk_id = ANY($1) AND status = 'pending'`,
        [addressedChunkIds]
      );
    }

    // Update topic freshness status
    if (!hasNewFlags) {
      // All chunks handled (no new flags) -> topic is fresh
      await client.query(
        `UPDATE topics
         SET to_be_refreshed = FALSE,
             last_refreshed_by = $1,
             last_refreshed_at = NOW(),
             refresh_check_count = refresh_check_count + 1,
             refresh_requested_by = NULL,
             refresh_requested_at = NULL,
             refresh_reason = NULL
         WHERE id = $2`,
        [accountId, topicId]
      );
    } else {
      // Some chunks flagged -> topic still needs refresh, but bump check count
      await client.query(
        `UPDATE topics
         SET last_refreshed_by = $1,
             last_refreshed_at = NOW(),
             refresh_check_count = refresh_check_count + 1
         WHERE id = $2`,
        [accountId, topicId]
      );
    }

    // Award reputation deltas
    const { DELTA_REFRESH_VERIFY, DELTA_REFRESH_UPDATE } = require('../../build/config/protocol');
    const totalDelta = (verifyCount * DELTA_REFRESH_VERIFY) + (updateCount * DELTA_REFRESH_UPDATE);
    if (totalDelta > 0) {
      await client.query(
        'UPDATE accounts SET reputation_contribution = LEAST(1.0, reputation_contribution + $1) WHERE id = $2',
        [totalDelta, accountId]
      );
    }

    await client.query('COMMIT');

    return {
      topicId,
      globalVerdict,
      operationsProcessed: operations.length,
      verifyCount,
      updateCount,
      flagCount: operations.filter(op => op.op === 'flag').length,
      topicFresh: !hasNewFlags,
      activityLogId,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * List topics needing refresh, sorted by urgency score.
 * urgency = age_factor + flags_factor
 */
async function listRefreshQueue({ limit = 20, offset = 0 } = {}) {
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.slug, t.lang, t.to_be_refreshed,
            t.last_refreshed_at, t.last_refreshed_by, t.refresh_check_count,
            t.refresh_requested_at, t.refresh_reason,
            a_refresher.name AS last_refreshed_by_name,
            COALESCE(pf.pending_flag_count, 0)::int AS pending_flag_count,
            -- Urgency score
            GREATEST(0,
              EXTRACT(EPOCH FROM (NOW() - COALESCE(t.last_refreshed_at, t.created_at))) / 86400 - $3
            ) / $4::float AS age_factor,
            LEAST(1.0, COALESCE(pf.pending_flag_count, 0) * $5::float) AS flags_factor
     FROM topics t
     LEFT JOIN accounts a_refresher ON a_refresher.id = t.last_refreshed_by
     LEFT JOIN (
       SELECT ct.topic_id, COUNT(*)::int AS pending_flag_count
       FROM chunk_refresh_flags crf
       JOIN chunk_topics ct ON ct.chunk_id = crf.chunk_id
       WHERE crf.status = 'pending'
       GROUP BY ct.topic_id
     ) pf ON pf.topic_id = t.id
     WHERE t.topic_type = 'knowledge'
     ORDER BY (
       GREATEST(0,
         EXTRACT(EPOCH FROM (NOW() - COALESCE(t.last_refreshed_at, t.created_at))) / 86400 - $3
       ) / $4::float
       + LEAST(1.0, COALESCE(pf.pending_flag_count, 0) * $5::float)
     ) DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset, AGE_GRACE_DAYS, DECAY_DAYS - AGE_GRACE_DAYS, FLAG_WEIGHT]
  );

  return rows.map(row => ({
    ...row,
    urgency_score: parseFloat(row.age_factor) + parseFloat(row.flags_factor),
    age_factor: parseFloat(row.age_factor),
    flags_factor: parseFloat(row.flags_factor),
  }));
}

/**
 * Dismiss a refresh flag (mark as not relevant).
 * Requires policing badge (enforced at route level).
 */
async function dismissFlag(flagId, accountId, reason) {
  const pool = getPool();

  const { rows } = await pool.query(
    `UPDATE chunk_refresh_flags
     SET status = 'dismissed', dismissed_by = $1, dismissed_at = NOW(), dismissed_reason = $2
     WHERE id = $3 AND status = 'pending'
     RETURNING *`,
    [accountId, reason, flagId]
  );

  if (rows.length === 0) {
    throw Object.assign(new Error('Flag not found or already resolved'), { code: 'NOT_FOUND' });
  }

  // Award negative reputation to the flagger for invalid flag
  const { DELTA_REFRESH_FLAG_INVALID } = require('../../build/config/protocol');
  const flag = rows[0];
  await pool.query(
    'UPDATE accounts SET reputation_contribution = GREATEST(0, reputation_contribution + $1) WHERE id = $2',
    [DELTA_REFRESH_FLAG_INVALID, flag.flagged_by]
  );

  // Check if topic still has pending flags; if not, clear to_be_refreshed
  const { rows: remainingFlags } = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM chunk_refresh_flags crf
     JOIN chunk_topics ct ON ct.chunk_id = crf.chunk_id
     WHERE ct.topic_id = (
       SELECT ct2.topic_id FROM chunk_topics ct2 WHERE ct2.chunk_id = $1 LIMIT 1
     ) AND crf.status = 'pending'`,
    [flag.chunk_id]
  );

  if (remainingFlags[0].cnt === 0) {
    await pool.query(
      `UPDATE topics SET to_be_refreshed = FALSE
       WHERE id = (SELECT ct.topic_id FROM chunk_topics ct WHERE ct.chunk_id = $1 LIMIT 1)`,
      [flag.chunk_id]
    );
  }

  return rows[0];
}

/**
 * Get pending flag count for a topic (used for response enrichment).
 */
async function getPendingFlagCount(topicId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM chunk_refresh_flags crf
     JOIN chunk_topics ct ON ct.chunk_id = crf.chunk_id
     WHERE ct.topic_id = $1 AND crf.status = 'pending'`,
    [topicId]
  );
  return rows[0].count;
}

/**
 * Get pending flags per chunk for a topic (for GUI badges).
 */
async function getPendingFlagsByChunk(topicId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT crf.chunk_id, COUNT(*)::int AS flag_count
     FROM chunk_refresh_flags crf
     JOIN chunk_topics ct ON ct.chunk_id = crf.chunk_id
     WHERE ct.topic_id = $1 AND crf.status = 'pending'
     GROUP BY crf.chunk_id`,
    [topicId]
  );
  const map = {};
  for (const row of rows) {
    map[row.chunk_id] = row.flag_count;
  }
  return map;
}

module.exports = {
  flagChunk,
  getTopicRefreshFlags,
  submitRefresh,
  listRefreshQueue,
  dismissFlag,
  getPendingFlagCount,
  getPendingFlagsByChunk,
};
