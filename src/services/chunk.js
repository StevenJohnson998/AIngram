/**
 * Chunk service — CRUD operations for atomic knowledge units.
 */

const { getPool } = require('../config/database');
const { generateEmbedding } = require('./ollama');
const trustConfig = require('../config/trust');

/**
 * Create a chunk and link it to a topic.
 * Initial trust_score uses Beta prior: α/(α+β) based on contributor tier.
 */
async function createChunk({ content, technicalDetail, topicId, createdBy, isElite = false, hasBadgeContribution = false, title = null, subtitle = null, adhp = null }) {
  const pool = getPool();
  const client = await pool.connect();

  // Beta prior based on contributor tier
  let prior;
  if (isElite) prior = trustConfig.CHUNK_PRIOR_ELITE;
  else if (hasBadgeContribution) prior = trustConfig.CHUNK_PRIOR_ESTABLISHED;
  else prior = trustConfig.CHUNK_PRIOR_NEW;
  const initialTrust = prior[0] / (prior[0] + prior[1]);

  try {
    // Near-duplicate detection: check if a very similar chunk already exists on this topic
    // Non-blocking: if embedding or DB check fails, we skip the guard (better to allow than to block on infra error)
    try {
      const embedding = await generateEmbedding(content);
      if (embedding) {
        const vectorStr = `[${embedding.join(',')}]`;
        const dupeResult = await pool.query(
          `SELECT c.id, 1 - (c.embedding <=> $1::vector) AS similarity
           FROM chunks c
           JOIN chunk_topics ct ON ct.chunk_id = c.id
           WHERE ct.topic_id = $2 AND c.status = 'active' AND c.embedding IS NOT NULL
             AND 1 - (c.embedding <=> $1::vector) >= $3
           LIMIT 1`,
          [vectorStr, topicId, DUPLICATE_SIMILARITY_THRESHOLD]
        );
        if (dupeResult.rows.length > 0) {
          throw Object.assign(
            new Error(`A very similar chunk already exists on this topic (similarity: ${dupeResult.rows[0].similarity.toFixed(3)})`),
            { code: 'DUPLICATE_CONTENT', existingChunkId: dupeResult.rows[0].id }
          );
        }
      }
    } catch (dupeErr) {
      if (dupeErr.code === 'DUPLICATE_CONTENT') throw dupeErr;
      // Embedding or DB unavailable — skip duplicate check, allow creation
    }

    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO chunks (content, technical_detail, has_technical_detail, created_by, trust_score, title, subtitle, adhp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [content, technicalDetail || null, technicalDetail != null, createdBy, initialTrust, title, subtitle, adhp ? JSON.stringify(adhp) : null]
    );

    const chunk = rows[0];

    // Link chunk to topic
    await client.query(
      `INSERT INTO chunk_topics (chunk_id, topic_id)
       VALUES ($1, $2)`,
      [chunk.id, topicId]
    );

    await client.query('COMMIT');

    // Fire-and-forget: trigger subscription matching for newly proposed chunk
    const { matchNewChunk } = require('./subscription-matcher');
    matchNewChunk(chunk.id, 'proposed')
      .catch(err => console.error('Subscription matching failed (proposed):', err));

    return chunk;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get a chunk by ID with its sources.
 */
async function getChunkById(id) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT c.*,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', cs.id,
                  'source_url', cs.source_url,
                  'source_description', cs.source_description,
                  'added_by', cs.added_by,
                  'created_at', cs.created_at
                )
              ) FILTER (WHERE cs.id IS NOT NULL),
              '[]'::json
            ) AS sources
     FROM chunks c
     LEFT JOIN chunk_sources cs ON cs.chunk_id = c.id
     WHERE c.id = $1
     GROUP BY c.id`,
    [id]
  );

  return rows[0] || null;
}

/**
 * Update a chunk's content and/or technical detail.
 */
async function updateChunk(id, { content, technicalDetail }) {
  const pool = getPool();

  // Build dynamic update
  const setClauses = ['updated_at = now()'];
  const params = [];
  let idx = 1;

  if (content !== undefined) {
    setClauses.push(`content = $${idx++}`);
    params.push(content);
  }

  if (technicalDetail !== undefined) {
    setClauses.push(`technical_detail = $${idx++}`);
    params.push(technicalDetail);
    setClauses.push(`has_technical_detail = $${idx++}`);
    params.push(technicalDetail != null);
  }

  params.push(id);

  const { rows } = await pool.query(
    `UPDATE chunks SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );

  return rows[0] || null;
}

/**
 * Retract a chunk (soft delete).
 */
async function retractChunk(id) {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE chunks SET status = 'retracted', updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id]
  );

  return rows[0] || null;
}

/**
 * Add a source citation to a chunk.
 */
async function addSource(chunkId, { sourceUrl, sourceDescription, addedBy }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO chunk_sources (chunk_id, source_url, source_description, added_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [chunkId, sourceUrl || null, sourceDescription || null, addedBy]
  );

  return rows[0];
}

/**
 * Get chunks for a topic with pagination.
 */
async function getChunksByTopic(topicId, { status = 'active', page = 1, limit = 20 } = {}) {
  const pool = getPool();

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM chunk_topics ct
     JOIN chunks c ON c.id = ct.chunk_id
     WHERE ct.topic_id = $1 AND c.status = $2`,
    [topicId, status]
  );
  const total = countResult.rows[0].total;

  const offset = (page - 1) * limit;
  const dataResult = await pool.query(
    `SELECT c.*
     FROM chunk_topics ct
     JOIN chunks c ON c.id = ct.chunk_id
     WHERE ct.topic_id = $1 AND c.status = $2
     ORDER BY c.created_at DESC
     LIMIT $3 OFFSET $4`,
    [topicId, status, limit, offset]
  );

  return {
    data: dataResult.rows,
    pagination: { page, limit, total },
  };
}

/**
 * Propose an edit to an existing chunk.
 * Creates a new chunk with status='proposed', linked via parent_chunk_id.
 */
async function proposeEdit({ originalChunkId, content, technicalDetail, proposedBy, topicId, isElite = false, hasBadgeContribution = false }) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get original chunk version
    const { rows: origRows } = await client.query(
      'SELECT version FROM chunks WHERE id = $1',
      [originalChunkId]
    );
    if (origRows.length === 0) {
      throw Object.assign(new Error('Original chunk not found'), { code: 'NOT_FOUND' });
    }
    const newVersion = origRows[0].version + 1;
    let prior;
    if (isElite) prior = trustConfig.CHUNK_PRIOR_ELITE;
    else if (hasBadgeContribution) prior = trustConfig.CHUNK_PRIOR_ESTABLISHED;
    else prior = trustConfig.CHUNK_PRIOR_NEW;
    const initialTrust = prior[0] / (prior[0] + prior[1]);

    const { rows } = await client.query(
      `INSERT INTO chunks (content, technical_detail, has_technical_detail, created_by, proposed_by,
                           status, version, parent_chunk_id, trust_score)
       VALUES ($1, $2, $3, $4, $4, 'proposed', $5, $6, $7)
       RETURNING *`,
      [content, technicalDetail || null, technicalDetail != null, proposedBy, newVersion, originalChunkId, initialTrust]
    );

    const chunk = rows[0];

    // Link proposed chunk to same topic
    if (topicId) {
      await client.query(
        'INSERT INTO chunk_topics (chunk_id, topic_id) VALUES ($1, $2)',
        [chunk.id, topicId]
      );
    }

    await client.query('COMMIT');
    return chunk;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Merge a proposed chunk: original → superseded, proposed → active.
 */
async function mergeChunk(proposedChunkId, mergedById) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get the proposed chunk
    const { rows: propRows } = await client.query(
      "SELECT * FROM chunks WHERE id = $1 AND status = 'proposed'",
      [proposedChunkId]
    );
    if (propRows.length === 0) {
      throw Object.assign(new Error('Proposed chunk not found or not in proposed status'), { code: 'NOT_FOUND' });
    }
    const proposed = propRows[0];

    // Supersede the original
    if (proposed.parent_chunk_id) {
      await client.query(
        "UPDATE chunks SET status = 'superseded', updated_at = now() WHERE id = $1",
        [proposed.parent_chunk_id]
      );
    }

    // Activate the proposed chunk
    const { rows: merged } = await client.query(
      `UPDATE chunks SET status = 'active', merged_at = now(), merged_by = $1, updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [mergedById, proposedChunkId]
    );

    await client.query('COMMIT');

    // Fire-and-forget: trigger subscription matching for newly active chunk
    const { matchNewChunk } = require('./subscription-matcher');
    matchNewChunk(proposedChunkId, 'active')
      .catch(err => console.error('Subscription matching failed:', err));

    return merged[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reject a proposed chunk.
 */
async function rejectChunk(proposedChunkId, { reason, report, rejectedBy } = {}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE chunks SET status = 'retracted', updated_at = now(),
            reject_reason = $2, rejected_by = $3, rejected_at = now()
     WHERE id = $1 AND status = 'proposed'
     RETURNING *`,
    [proposedChunkId, reason || null, rejectedBy || null]
  );
  if (rows.length === 0) {
    throw Object.assign(new Error('Proposed chunk not found or not in proposed status'), { code: 'NOT_FOUND' });
  }
  if (report && reason && rejectedBy) {
    const flagService = require('./flag');
    await flagService.createFlag({
      targetType: 'chunk',
      targetId: proposedChunkId,
      reason: '[SERIOUS] ' + reason,
      reporterId: rejectedBy,
    });
  }
  return rows[0];
}

/**
 * Propose reverting a chunk to a previous version.
 * Copies content from a historical chunk and creates a new proposed chunk.
 */
async function proposeRevert({ chunkId, targetVersion, reason, proposedBy, topicId }) {
  const pool = getPool();

  // Find the target version in the chunk lineage
  // Walk back through parent_chunk_id to find the version
  const { rows: targetRows } = await pool.query(
    `WITH RECURSIVE lineage AS (
       SELECT id, content, technical_detail, has_technical_detail, version, parent_chunk_id
       FROM chunks WHERE id = $1
       UNION ALL
       SELECT c.id, c.content, c.technical_detail, c.has_technical_detail, c.version, c.parent_chunk_id
       FROM chunks c JOIN lineage l ON c.id = l.parent_chunk_id
     )
     SELECT * FROM lineage WHERE version = $2`,
    [chunkId, targetVersion]
  );

  if (targetRows.length === 0) {
    throw Object.assign(new Error('Target version not found in chunk lineage'), { code: 'NOT_FOUND' });
  }

  const target = targetRows[0];
  return proposeEdit({
    originalChunkId: chunkId,
    content: target.content,
    technicalDetail: target.technical_detail,
    proposedBy,
    topicId,
  });
}

/**
 * Get version history for a topic (all chunk versions chronologically).
 */
async function getTopicHistory(topicId, { page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM chunk_topics ct
     JOIN chunks c ON c.id = ct.chunk_id
     WHERE ct.topic_id = $1`,
    [topicId]
  );
  const total = countResult.rows[0].total;

  const dataResult = await pool.query(
    `SELECT c.id AS "chunkId", c.version, c.status, c.parent_chunk_id AS "parentChunkId",
            c.content, c.trust_score,
            c.proposed_by, pa.name AS proposed_by_name,
            c.merged_by, ma.name AS merged_by_name,
            c.merged_at AS "mergedAt", c.created_at AS "createdAt"
     FROM chunk_topics ct
     JOIN chunks c ON c.id = ct.chunk_id
     LEFT JOIN accounts pa ON pa.id = c.proposed_by
     LEFT JOIN accounts ma ON ma.id = c.merged_by
     WHERE ct.topic_id = $1
     ORDER BY c.created_at DESC
     LIMIT $2 OFFSET $3`,
    [topicId, limit, offset]
  );

  const data = dataResult.rows.map(row => ({
    chunkId: row.chunkId,
    version: row.version,
    status: row.status,
    parentChunkId: row.parentChunkId,
    content: row.content,
    trustScore: row.trust_score,
    proposedBy: row.proposed_by ? { id: row.proposed_by, name: row.proposed_by_name } : null,
    mergedBy: row.merged_by ? { id: row.merged_by, name: row.merged_by_name } : null,
    mergedAt: row.mergedAt,
    createdAt: row.createdAt,
  }));

  return { data, pagination: { page, limit, total } };
}

/**
 * Get proposed edits for a chunk.
 */
async function getProposedEdits(chunkId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT c.*, a.name AS proposed_by_name
     FROM chunks c
     LEFT JOIN accounts a ON a.id = c.proposed_by
     WHERE c.parent_chunk_id = $1 AND c.status = 'proposed'
     ORDER BY c.created_at DESC`,
    [chunkId]
  );
  return rows;
}

/**
 * Get all pending proposed chunks (for review queue).
 */
async function listPendingProposals({ page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const countResult = await pool.query(
    "SELECT COUNT(*)::int AS total FROM chunks WHERE status = 'proposed'"
  );
  const total = countResult.rows[0].total;

  const dataResult = await pool.query(
    `SELECT c.*, a.name AS proposed_by_name,
            pc.content AS original_content,
            t.id AS topic_id, t.title AS topic_title, t.slug AS topic_slug,
            t.lang AS topic_lang, t.agorai_conversation_id
     FROM chunks c
     LEFT JOIN accounts a ON a.id = c.proposed_by
     LEFT JOIN chunks pc ON pc.id = c.parent_chunk_id
     LEFT JOIN chunk_topics ct ON ct.chunk_id = c.id
     LEFT JOIN topics t ON t.id = ct.topic_id
     WHERE c.status = 'proposed'
     ORDER BY c.created_at ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return { data: dataResult.rows, pagination: { page, limit, total } };
}

module.exports = {
  createChunk,
  getChunkById,
  updateChunk,
  retractChunk,
  addSource,
  getChunksByTopic,
  proposeEdit,
  mergeChunk,
  rejectChunk,
  proposeRevert,
  getTopicHistory,
  getProposedEdits,
  listPendingProposals,
};
