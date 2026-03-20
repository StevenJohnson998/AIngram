const { getPool } = require('../config/database');

/**
 * Find subscriptions that match a newly embedded chunk.
 * Checks three subscription types: vector, keyword, topic.
 * Does NOT dispatch notifications (Phase 3).
 *
 * @param {string} chunkId - UUID of the newly embedded chunk
 * @param {'active'|'proposed'} triggerStatus - chunk status that triggered the match
 * @returns {Array<{subscriptionId, accountId, matchType: 'vector'|'keyword'|'topic', similarity?}>}
 */
async function matchNewChunk(chunkId, triggerStatus = 'active') {
  const pool = getPool();

  // 1. Get chunk data: embedding, content, and associated topic IDs
  const { rows: chunkRows } = await pool.query(
    'SELECT id, content, embedding FROM chunks WHERE id = $1',
    [chunkId]
  );

  if (chunkRows.length === 0) {
    console.warn(`matchNewChunk: chunk ${chunkId} not found`);
    return [];
  }

  const chunk = chunkRows[0];

  // Get topic IDs for this chunk
  const { rows: topicRows } = await pool.query(
    'SELECT topic_id FROM chunk_topics WHERE chunk_id = $1',
    [chunkId]
  );
  const topicIds = topicRows.map((r) => r.topic_id);

  // Determine which trigger_status values to match
  const triggerFilter = triggerStatus === 'proposed'
    ? ['proposed', 'both']
    : ['active', 'both'];

  const matches = [];

  // 2. Vector subscriptions: cosine similarity >= threshold
  if (chunk.embedding) {
    const { rows: vectorSubs } = await pool.query(
      `SELECT s.id as subscription_id, s.account_id, s.similarity_threshold,
              1 - (s.embedding <=> c.embedding) as similarity
       FROM subscriptions s, chunks c
       WHERE c.id = $1
         AND s.type = 'vector'
         AND s.active = true
         AND s.embedding IS NOT NULL
         AND s.trigger_status = ANY($2)
         AND 1 - (s.embedding <=> c.embedding) >= COALESCE(s.similarity_threshold, 0.7)`,
      [chunkId, triggerFilter]
    );

    for (const sub of vectorSubs) {
      matches.push({
        subscriptionId: sub.subscription_id,
        accountId: sub.account_id,
        matchType: 'vector',
        similarity: parseFloat(sub.similarity),
      });
    }
  }

  // 3. Keyword subscriptions: ILIKE on chunk content
  const { rows: keywordSubs } = await pool.query(
    `SELECT id as subscription_id, account_id, keyword
     FROM subscriptions
     WHERE type = 'keyword'
       AND active = true
       AND keyword IS NOT NULL
       AND trigger_status = ANY($1)`,
    [triggerFilter]
  );

  for (const sub of keywordSubs) {
    if (chunk.content.toLowerCase().includes(sub.keyword.toLowerCase())) {
      matches.push({
        subscriptionId: sub.subscription_id,
        accountId: sub.account_id,
        matchType: 'keyword',
      });
    }
  }

  // 4. Topic subscriptions: chunk's topic_id matches subscription topic_id
  if (topicIds.length > 0) {
    const { rows: topicSubs } = await pool.query(
      `SELECT id as subscription_id, account_id, topic_id
       FROM subscriptions
       WHERE type = 'topic'
         AND active = true
         AND topic_id = ANY($1)
         AND trigger_status = ANY($2)`,
      [topicIds, triggerFilter]
    );

    for (const sub of topicSubs) {
      matches.push({
        subscriptionId: sub.subscription_id,
        accountId: sub.account_id,
        matchType: 'topic',
      });
    }
  }

  return matches;
}

module.exports = { matchNewChunk };
