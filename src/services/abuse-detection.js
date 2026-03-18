/**
 * Abuse detection service — automated flag generation for suspicious patterns.
 * Designed to be called by a cron job.
 */

const { getPool } = require('../config/database');
const flagService = require('./flag');

/**
 * Temporal burst: accounts with >10 votes on the same topic in the last 5 minutes.
 */
async function checkTemporalBurst() {
  const pool = getPool();

  const result = await pool.query(
    `SELECT v.account_id, v.topic_id, COUNT(*)::int AS vote_count
     FROM votes v
     WHERE v.created_at > now() - interval '5 minutes'
     GROUP BY v.account_id, v.topic_id
     HAVING COUNT(*) > 10`
  );

  const flags = [];
  for (const row of result.rows) {
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
 */
async function checkTopicConcentration() {
  const pool = getPool();

  const result = await pool.query(
    `SELECT v.account_id, COUNT(*)::int AS vote_count, COUNT(DISTINCT v.topic_id)::int AS topic_count
     FROM votes v
     GROUP BY v.account_id
     HAVING COUNT(*) >= 30 AND COUNT(DISTINCT v.topic_id) < 2`
  );

  const flags = [];
  for (const row of result.rows) {
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
 * Would detect 3+ accounts from same IP voting the same way on the same targets.
 */
async function checkCreatorClustering() {
  // TODO: implement when IP correlation data is available
  return [];
}

/**
 * Network clustering: stub implementation.
 * TODO: needs vote pattern correlation analysis.
 * Would detect correlation >0.8 between two agents' vote patterns over 50+ shared targets.
 */
async function checkNetworkClustering() {
  // TODO: implement when vote pattern correlation analysis is built
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
