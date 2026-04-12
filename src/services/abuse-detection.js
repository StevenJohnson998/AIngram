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

// ─── S5 Sybil helpers ────────────────────────────────────────────────
//
// Real-but-conservative helpers backing the existing checkCreatorClustering
// stub. Designed to be called from policing tools, future moderation UI, or
// the worker when we want stronger Sybil signal.
//
// Why these are stubs (not enforcing): the heuristics are coarse and the
// test stack only has a handful of accounts -- a real threshold needs tuning
// against production traffic. The functions return data; downstream code
// decides whether to flag.

/**
 * Returns true if the account is younger than `minDays`.
 * Used by gating logic to delay sensitive actions for new accounts.
 */
async function isAccountTooYoung(accountId, minDays = 7) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT created_at < now() - ($2 || ' days')::interval AS old_enough
     FROM accounts WHERE id = $1`,
    [accountId, String(minDays)]
  );
  if (rows.length === 0) return true; // unknown account treated as too young
  return rows[0].old_enough === false;
}

/**
 * Returns the list of other accounts that share the same registration IP.
 * Excludes the input account itself. Returns an empty array when:
 *   - the account has no creator_ip recorded (legacy accounts pre-S5)
 *   - no other account shares that IP
 *
 * This is the building block for getCreatorClusterSize and any future
 * clustering logic. It is intentionally conservative: same-IP correlation
 * has known false positives (NAT, university networks, ISP CGNAT) so the
 * threshold for action must be tuned with operational data.
 */
async function getRelatedAccountsByIp(accountId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT a2.id, a2.name, a2.created_at, a2.status
     FROM accounts a1
     JOIN accounts a2 ON a2.creator_ip = a1.creator_ip
     WHERE a1.id = $1
       AND a1.creator_ip IS NOT NULL
       AND a2.id != a1.id
     ORDER BY a2.created_at DESC`,
    [accountId]
  );
  return rows;
}

/**
 * Cluster size = number of OTHER accounts sharing this account's registration IP.
 * Convenience wrapper around getRelatedAccountsByIp.
 */
async function getCreatorClusterSize(accountId) {
  const related = await getRelatedAccountsByIp(accountId);
  return related.length;
}

/**
 * Detect creator cluster around an account. Returns { size, related }
 * when the cluster is non-trivial (more than `threshold` other accounts),
 * or null when below threshold.
 *
 * Default threshold is intentionally high (5) -- below that, false positives
 * from NAT/CGNAT are too common to act on.
 */
async function detectCreatorCluster(accountId, threshold = 5) {
  const related = await getRelatedAccountsByIp(accountId);
  if (related.length < threshold) return null;
  return {
    size: related.length,
    related: related.map(r => ({ id: r.id, name: r.name, createdAt: r.created_at, status: r.status })),
  };
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
  // S5 Sybil helpers
  isAccountTooYoung,
  getRelatedAccountsByIp,
  getCreatorClusterSize,
  detectCreatorCluster,
};
