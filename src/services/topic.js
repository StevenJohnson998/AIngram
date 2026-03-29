/**
 * Topic service — CRUD operations for knowledge base topics.
 */

const { getPool } = require('../config/database');
const { generateSlug, ensureUniqueSlug } = require('../utils/slug');

/**
 * Create a new topic.
 */
async function createTopic({ title, lang, summary, sensitivity, createdBy }) {
  const pool = getPool();
  const baseSlug = generateSlug(title);
  const slug = await ensureUniqueSlug(baseSlug, lang, pool);

  const { rows } = await pool.query(
    `INSERT INTO topics (title, slug, lang, summary, sensitivity, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [title, slug, lang, summary || null, sensitivity || 'low', createdBy]
  );

  return rows[0];
}

/**
 * Get a topic by ID, including count of active chunks.
 */
async function getTopicById(id) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT t.*,
            (SELECT COUNT(*) FROM chunk_topics ct
             JOIN chunks c ON c.id = ct.chunk_id
             WHERE ct.topic_id = t.id AND c.status = 'active' AND c.hidden = false)::int AS chunk_count
     FROM topics t
     WHERE t.id = $1`,
    [id]
  );

  return rows[0] || null;
}

/**
 * Get a topic by slug and language.
 */
async function getTopicBySlug(slug, lang) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT t.*,
            (SELECT COUNT(*) FROM chunk_topics ct
             JOIN chunks c ON c.id = ct.chunk_id
             WHERE ct.topic_id = t.id AND c.status = 'active' AND c.hidden = false)::int AS chunk_count
     FROM topics t
     WHERE t.slug = $1 AND t.lang = $2`,
    [slug, lang]
  );

  return rows[0] || null;
}

/**
 * List topics with filters and pagination.
 */
async function listTopics({ lang, status, sensitivity, page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const conditions = [];
  const params = [];
  let idx = 1;

  if (lang) {
    conditions.push(`t.lang = $${idx++}`);
    params.push(lang);
  }
  if (status) {
    conditions.push(`t.status = $${idx++}`);
    params.push(status);
  }
  if (sensitivity) {
    conditions.push(`t.sensitivity = $${idx++}`);
    params.push(sensitivity);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM topics t ${whereClause}`,
    params
  );
  const total = countResult.rows[0].total;

  // Fetch page
  const offset = (page - 1) * limit;
  const dataResult = await pool.query(
    `SELECT t.*
     FROM topics t
     ${whereClause}
     ORDER BY t.created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset]
  );

  return {
    data: dataResult.rows,
    pagination: { page, limit, total },
  };
}

/**
 * Update a topic. Regenerates slug if title changed.
 */
async function updateTopic(id, { title, summary, sensitivity }) {
  const pool = getPool();

  // Get current topic to check if title changed
  const { rows: current } = await pool.query(
    'SELECT * FROM topics WHERE id = $1',
    [id]
  );
  if (current.length === 0) return null;

  const topic = current[0];
  let slug = topic.slug;

  // Regenerate slug if title changed
  if (title && title !== topic.title) {
    const baseSlug = generateSlug(title);
    slug = await ensureUniqueSlug(baseSlug, topic.lang, pool);
  }

  const { rows } = await pool.query(
    `UPDATE topics
     SET title = COALESCE($1, title),
         slug = $2,
         summary = COALESCE($3, summary),
         sensitivity = COALESCE($4, sensitivity),
         updated_at = now()
     WHERE id = $5
     RETURNING *`,
    [title || topic.title, slug, summary, sensitivity, id]
  );

  return rows[0] || null;
}

/**
 * Flag a topic for content issues.
 */
async function flagTopic(id, { contentFlag, reason, flaggedBy }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE topics
     SET content_flag = $1,
         content_flag_reason = $2,
         content_flagged_by = $3,
         content_flagged_at = now(),
         updated_at = now()
     WHERE id = $4
     RETURNING *`,
    [contentFlag, reason, flaggedBy, id]
  );

  return rows[0] || null;
}

/**
 * Get translations linked to a topic.
 */
async function getTranslations(topicId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT t.*
     FROM topic_translations tt
     JOIN topics t ON t.id = tt.translated_id
     WHERE tt.topic_id = $1`,
    [topicId]
  );

  return rows;
}

/**
 * Link two topics as translations (bidirectional).
 */
async function linkTranslation(topicId, translatedId) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Insert both directions, ignore if already exists
    await client.query(
      `INSERT INTO topic_translations (topic_id, translated_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [topicId, translatedId]
    );

    await client.query(
      `INSERT INTO topic_translations (topic_id, translated_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [translatedId, topicId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createTopic,
  getTopicById,
  getTopicBySlug,
  listTopics,
  updateTopic,
  flagTopic,
  getTranslations,
  linkTranslation,
};
