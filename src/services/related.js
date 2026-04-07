/**
 * Related content discovery -- "See Also" feature.
 * Two signals: chunk embedding similarity + topic-level embedding similarity.
 * Results are deduplicated and re-ranked by combined score.
 */

const { getPool } = require('../config/database');

// Config: server-controlled, not exposed as API params
const RELATED_LIMIT = parseInt(process.env.RELATED_LIMIT, 10) || 5;
const RELATED_MAX = 10;
const MIN_SIMILARITY = 0.3;

/**
 * Find related chunks from OTHER topics via embedding nearest neighbor.
 * Returns top candidates with topic metadata.
 */
async function relatedByChunkEmbedding(topicId, limit) {
  const pool = getPool();
  const cap = Math.min(limit, RELATED_MAX);

  const { rows } = await pool.query(
    `WITH topic_chunks AS (
       SELECT embedding FROM chunks c
       JOIN chunk_topics ct ON ct.chunk_id = c.id
       WHERE ct.topic_id = $1
         AND c.embedding IS NOT NULL
         AND c.status = 'published'
       LIMIT 1
     )
     SELECT c.id AS chunk_id, c.content, c.title AS chunk_title,
            t.id AS topic_id, t.title AS topic_title, t.slug AS topic_slug,
            (1 - (c.embedding <=> tc.embedding)) AS similarity
     FROM chunks c
     JOIN chunk_topics ct ON ct.chunk_id = c.id
     JOIN topics t ON t.id = ct.topic_id
     CROSS JOIN topic_chunks tc
     WHERE ct.topic_id != $1
       AND c.embedding IS NOT NULL
       AND c.status = 'published'
       AND c.hidden = false
       AND (1 - (c.embedding <=> tc.embedding)) >= $2
     ORDER BY similarity DESC
     LIMIT $3`,
    [topicId, MIN_SIMILARITY, cap * 2]
  );

  return rows;
}

/**
 * Find related topics by average embedding distance.
 * Computes the centroid of a topic's chunk embeddings and finds nearest topic centroids.
 */
async function relatedByTopicEmbedding(topicId, limit) {
  const pool = getPool();
  const cap = Math.min(limit, RELATED_MAX);

  const { rows } = await pool.query(
    `WITH source_centroid AS (
       SELECT AVG(c.embedding) AS centroid
       FROM chunks c
       JOIN chunk_topics ct ON ct.chunk_id = c.id
       WHERE ct.topic_id = $1
         AND c.embedding IS NOT NULL
         AND c.status = 'published'
     ),
     topic_centroids AS (
       SELECT ct.topic_id, AVG(c.embedding) AS centroid
       FROM chunks c
       JOIN chunk_topics ct ON ct.chunk_id = c.id
       WHERE c.embedding IS NOT NULL
         AND c.status = 'published'
         AND ct.topic_id != $1
       GROUP BY ct.topic_id
     )
     SELECT tc.topic_id, t.title AS topic_title, t.slug AS topic_slug,
            (1 - (tc.centroid <=> sc.centroid)) AS similarity
     FROM topic_centroids tc
     CROSS JOIN source_centroid sc
     JOIN topics t ON t.id = tc.topic_id
     WHERE sc.centroid IS NOT NULL
       AND (1 - (tc.centroid <=> sc.centroid)) >= $2
     ORDER BY similarity DESC
     LIMIT $3`,
    [topicId, MIN_SIMILARITY, cap]
  );

  return rows;
}

/**
 * Find related chunks for a specific chunk (cross-topic).
 */
async function relatedChunks(chunkId, limit) {
  const pool = getPool();
  const cap = Math.min(limit, RELATED_MAX);

  const { rows } = await pool.query(
    `SELECT c2.id AS chunk_id, c2.content, c2.title AS chunk_title,
            t.id AS topic_id, t.title AS topic_title, t.slug AS topic_slug,
            (1 - (c2.embedding <=> c1.embedding)) AS similarity
     FROM chunks c1
     JOIN chunks c2 ON c2.id != c1.id AND c2.embedding IS NOT NULL
     JOIN chunk_topics ct1 ON ct1.chunk_id = c1.id
     JOIN chunk_topics ct2 ON ct2.chunk_id = c2.id
     JOIN topics t ON t.id = ct2.topic_id
     WHERE c1.id = $1
       AND c1.embedding IS NOT NULL
       AND ct2.topic_id != ct1.topic_id
       AND c2.status = 'published'
       AND c2.hidden = false
       AND (1 - (c2.embedding <=> c1.embedding)) >= $2
     ORDER BY similarity DESC
     LIMIT $3`,
    [chunkId, MIN_SIMILARITY, cap]
  );

  return rows;
}

/**
 * Combined related topics: merge chunk-level and topic-level signals,
 * deduplicate by topic, keep highest score per topic.
 */
async function getRelatedTopics(topicId) {
  const limit = RELATED_LIMIT;

  const [chunkResults, topicResults] = await Promise.all([
    relatedByChunkEmbedding(topicId, limit),
    relatedByTopicEmbedding(topicId, limit),
  ]);

  // Merge: best score per topic, track signal source
  const topicMap = new Map();

  for (const r of chunkResults) {
    const existing = topicMap.get(r.topic_id);
    const score = parseFloat(r.similarity);
    if (!existing || score > existing.score) {
      topicMap.set(r.topic_id, {
        topicId: r.topic_id,
        topicTitle: r.topic_title,
        topicSlug: r.topic_slug,
        chunkExcerpt: (r.content || '').slice(0, 200),
        score,
        signal: 'chunk_embedding',
      });
    }
  }

  for (const r of topicResults) {
    const existing = topicMap.get(r.topic_id);
    const score = parseFloat(r.similarity);
    if (!existing || score > existing.score) {
      topicMap.set(r.topic_id, {
        topicId: r.topic_id,
        topicTitle: r.topic_title,
        topicSlug: r.topic_slug,
        chunkExcerpt: existing?.chunkExcerpt || '',
        score,
        signal: 'topic_embedding',
      });
    }
  }

  // Sort by score desc, limit
  return Array.from(topicMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

module.exports = {
  relatedChunks,
  getRelatedTopics,
  relatedByChunkEmbedding,
  relatedByTopicEmbedding,
  RELATED_LIMIT,
  RELATED_MAX,
};
