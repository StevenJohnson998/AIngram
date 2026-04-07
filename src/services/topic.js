/**
 * Topic service — CRUD operations for knowledge base topics.
 */

const { getPool } = require('../config/database');
const { generateSlug, ensureUniqueSlug } = require('../utils/slug');

/**
 * Create a new topic.
 */
async function createTopic({ title, lang, summary, sensitivity, topicType, createdBy }) {
  const pool = getPool();
  const baseSlug = generateSlug(title);
  const slug = await ensureUniqueSlug(baseSlug, lang, pool);

  const { rows } = await pool.query(
    `INSERT INTO topics (title, slug, lang, summary, sensitivity, topic_type, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [title, slug, lang, summary || null, sensitivity || 'standard', topicType || 'knowledge', createdBy]
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
             WHERE ct.topic_id = t.id AND c.status = 'published' AND c.hidden = false)::int AS chunk_count
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
             WHERE ct.topic_id = t.id AND c.status = 'published' AND c.hidden = false)::int AS chunk_count
     FROM topics t
     WHERE t.slug = $1 AND t.lang = $2`,
    [slug, lang]
  );

  return rows[0] || null;
}

/**
 * List topics with filters and pagination.
 */
async function listTopics({ lang, status, sensitivity, topicType, page = 1, limit = 20 } = {}) {
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
  if (topicType) {
    conditions.push(`t.topic_type = $${idx++}`);
    params.push(topicType);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM topics t ${whereClause}`,
    params
  );
  const total = countResult.rows[0].total;

  // Fetch page with article summary and discussion message count
  const offset = (page - 1) * limit;
  const dataResult = await pool.query(
    `SELECT t.*,
            sc.article_summary,
            COALESCE(dm.discussion_message_count, 0)::int AS discussion_message_count
     FROM topics t
     LEFT JOIN LATERAL (
       SELECT c.article_summary FROM chunks c
       JOIN chunk_topics ct ON ct.chunk_id = c.id
       WHERE ct.topic_id = t.id AND c.chunk_type = 'summary' AND c.status = 'published'
       LIMIT 1
     ) sc ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS discussion_message_count FROM activity_log
       WHERE action = 'discussion_post' AND target_type = 'topic' AND target_id = t.id
     ) dm ON true
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
async function updateTopic(id, { title, summary, sensitivity, topicType }) {
  const pool = getPool();

  // Get current topic to check if title changed
  const { rows: current } = await pool.query(
    'SELECT * FROM topics WHERE id = $1',
    [id]
  );
  if (current.length === 0) return null;

  const topic = current[0];

  // topic_type is immutable after creation
  if (topicType && topicType !== topic.topic_type) {
    const err = new Error('topic_type is immutable after creation');
    err.status = 400;
    throw err;
  }
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

/**
 * Create a topic with multiple chunks in a single atomic transaction.
 * All chunks start as 'proposed'. Embeddings + subscription matching fire-and-forget after commit.
 */
async function createTopicFull({ title, lang, summary, sensitivity, topicType, createdBy, chunks, isElite = false, hasBadgeContribution = false }) {
  const pool = getPool();
  const client = await pool.connect();
  const chunkService = require('./chunk');
  const trustConfig = require('../config/trust');
  const { analyzeContent } = require('./injection-detector');
  const accountService = require('./account');
  const { matchNewChunk } = require('./subscription-matcher');
  const { dispatchNotification } = require('./notification');

  // Compute trust prior once
  let prior;
  if (isElite) prior = trustConfig.CHUNK_PRIOR_ELITE;
  else if (hasBadgeContribution) prior = trustConfig.CHUNK_PRIOR_ESTABLISHED;
  else prior = trustConfig.CHUNK_PRIOR_NEW;
  const initialTrust = prior[0] / (prior[0] + prior[1]);

  try {
    await client.query('BEGIN');

    // 1. Create topic
    const baseSlug = generateSlug(title);
    const slug = await ensureUniqueSlug(baseSlug, lang, pool);
    const { rows: topicRows } = await client.query(
      `INSERT INTO topics (title, slug, lang, summary, sensitivity, topic_type, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [title, slug, lang, summary || null, sensitivity || 'standard', topicType || 'knowledge', createdBy]
    );
    const topic = topicRows[0];

    // 2. Create all chunks in the same transaction
    const chunkResults = [];
    for (const chunkData of chunks) {
      const injectionResult = analyzeContent(chunkData.content);
      const chunk = await chunkService._insertChunkInTx(client, {
        content: chunkData.content,
        technicalDetail: chunkData.technicalDetail,
        createdBy,
        topicId: topic.id,
        initialTrust,
        title: chunkData.title,
        subtitle: chunkData.subtitle,
        adhp: chunkData.adhp,
        injectionResult,
      });

      // Attach sources within the same transaction
      if (chunkData.sources && chunkData.sources.length > 0) {
        for (const src of chunkData.sources) {
          await client.query(
            `INSERT INTO chunk_sources (chunk_id, source_url, source_description, added_by)
             VALUES ($1, $2, $3, $4)`,
            [chunk.id, src.sourceUrl || null, src.sourceDescription || null, createdBy]
          );
        }
      }

      chunkResults.push({ id: chunk.id, status: chunk.status });
    }

    // 3. Activity log for bulk creation
    await client.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES ($1, 'topic_created_full', 'topic', $2, $3)`,
      [createdBy, topic.id, JSON.stringify({ chunkCount: chunkResults.length })]
    );

    await client.query('COMMIT');

    // 4. Fire-and-forget: embeddings + subscription matching (after commit)
    for (const cr of chunkResults) {
      // Subscription matching
      (async () => {
        try {
          const matches = await matchNewChunk(cr.id, 'proposed');
          for (const match of matches) {
            await dispatchNotification(match).catch(() => {});
          }
        } catch (err) {
          console.error(`Match-and-notify failed for chunk ${cr.id}:`, err.message);
        }
      })();
    }

    // Fire-and-forget: tier update
    accountService.incrementInteractionAndUpdateTier(createdBy)
      .catch(err => console.error('Tier update failed:', err));

    return { topic, chunks: chunkResults };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createTopic,
  createTopicFull,
  getTopicById,
  getTopicBySlug,
  listTopics,
  updateTopic,
  flagTopic,
  getTranslations,
  linkTranslation,
};
