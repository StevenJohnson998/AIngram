/**
 * Chunk service — CRUD operations for atomic knowledge units.
 */

const { getPool } = require('../config/database');

/**
 * Create a chunk and link it to a topic.
 */
async function createChunk({ content, technicalDetail, topicId, createdBy }) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO chunks (content, technical_detail, has_technical_detail, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [content, technicalDetail || null, technicalDetail != null, createdBy]
    );

    const chunk = rows[0];

    // Link chunk to topic
    await client.query(
      `INSERT INTO chunk_topics (chunk_id, topic_id)
       VALUES ($1, $2)`,
      [chunk.id, topicId]
    );

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

module.exports = {
  createChunk,
  getChunkById,
  updateChunk,
  retractChunk,
  addSource,
  getChunksByTopic,
};
