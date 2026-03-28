/**
 * Abuse detection service — automated flag generation for suspicious patterns.
 * Designed to be called by the worker process on a schedule.
 */

const { getPool } = require('../config/database');
const flagService = require('./flag');

/**
 * Check if a similar flag already exists recently (idempotence guard).
 * Prevents duplicate flags when detection runs on a schedule.
 */
async function flagExists(pool, targetId, detectionType) {
  const { rows } = await pool.query(
    `SELECT 1 FROM flags
     WHERE target_id = $1 AND detection_type = $2
       AND created_at > now() - interval '1 hour'
     LIMIT 1`,
    [targetId, detectionType]
  );
  return rows.length > 0;
}

/**
 * Temporal burst: accounts with >10 votes on the same topic in the last 5 minutes.
 * Resolves topic_id via messages (for message votes) and chunk_topics (for chunk votes).
 */
async function checkTemporalBurst() {
  const pool = getPool();

  const result = await pool.query(
    `SELECT v.account_id, resolved.topic_id, COUNT(*)::int AS vote_count
     FROM votes v
     LEFT JOIN messages m ON m.id = v.target_id AND v.target_type = 'message'
     LEFT JOIN chunk_topics ct ON ct.chunk_id = v.target_id AND v.target_type = 'chunk'
     CROSS JOIN LATERAL (SELECT COALESCE(m.topic_id, ct.topic_id) AS topic_id) resolved
     WHERE v.created_at > now() - interval '5 minutes'
       AND resolved.topic_id IS NOT NULL
     GROUP BY v.account_id, resolved.topic_id
     HAVING COUNT(*) > 10`
  );

  const flags = [];
  for (const row of result.rows) {
    if (await flagExists(pool, row.account_id, 'temporal_burst')) continue;
    const flag = await flagService.createFlag({
      reporterId: row.account_id,
      targetType: 'account',
      targetId: row.account_id,
      reason: `Temporal burst: ${row.vote_count} votes on topic ${row.topic_id} in 5 minutes`,
      detectionType: 'temporal_burst',
    });
    flags.push(flag);
  }

  return flags;
}

/**
 * Topic concentration: accounts with 30+ votes on fewer than 2 distinct topics.
 * Resolves topic_id via messages (for message votes) and chunk_topics (for chunk votes).
 */
async function checkTopicConcentration() {
  const pool = getPool();

  const result = await pool.query(
    `SELECT v.account_id, COUNT(*)::int AS vote_count, COUNT(DISTINCT resolved.topic_id)::int AS topic_count
     FROM votes v
     LEFT JOIN messages m ON m.id = v.target_id AND v.target_type = 'message'
     LEFT JOIN chunk_topics ct ON ct.chunk_id = v.target_id AND v.target_type = 'chunk'
     CROSS JOIN LATERAL (SELECT COALESCE(m.topic_id, ct.topic_id) AS topic_id) resolved
     WHERE resolved.topic_id IS NOT NULL
     GROUP BY v.account_id
     HAVING COUNT(*) >= 30 AND COUNT(DISTINCT resolved.topic_id) < 2`
  );

  const flags = [];
  for (const row of result.rows) {
    if (await flagExists(pool, row.account_id, 'topic_concentration')) continue;
    const flag = await flagService.createFlag({
      reporterId: row.account_id,
      targetType: 'account',
      targetId: row.account_id,
      reason: `Topic concentration: ${row.vote_count} votes on only ${row.topic_count} distinct topic(s)`,
      detectionType: 'topic_concentration',
    });
    flags.push(flag);
  }

  return flags;
}

/**
 * Creator clustering: stub implementation.
 * TODO: needs IP correlation data — requires storing IP metadata per account session.
 */
async function checkCreatorClustering() {
  return [];
}

/**
 * Network clustering: stub implementation.
 * TODO: needs vote pattern correlation analysis.
 */
async function checkNetworkClustering() {
  return [];
}

/**
 * Run all detection methods.
 */
async function runAllDetections() {
  const results = {
    temporalBurst: await checkTemporalBurst(),
    topicConcentration: await checkTopicConcentration(),
    creatorClustering: await checkCreatorClustering(),
    networkClustering: await checkNetworkClustering(),
  };

  const totalFlags =
    results.temporalBurst.length +
    results.topicConcentration.length +
    results.creatorClustering.length +
    results.networkClustering.length;

  console.log(`Abuse detection complete: ${totalFlags} flags created`);
  return results;
}

module.exports = {
  checkTemporalBurst,
  checkTopicConcentration,
  checkCreatorClustering,
  checkNetworkClustering,
  runAllDetections,
};
