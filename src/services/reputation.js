/**
 * Reputation service — calculate reputation scores and badge eligibility.
 */

const { getPool } = require('../config/database');

/**
 * Recalculate reputation_contribution and reputation_policing for an account.
 * - contribution = votes on account's level-1 messages
 * - policing = votes on account's level-2 messages
 * Formula: (sum_up_weights - sum_down_weights) / total_weight, normalized -1 to +1
 */
async function recalculateReputation(accountId) {
  const pool = getPool();

  // Contribution reputation: votes on level-1 messages by this account
  const { rows: contribRows } = await pool.query(
    `SELECT
       COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'up'), 0)::float AS up_weight,
       COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'down'), 0)::float AS down_weight,
       COALESCE(SUM(v.weight), 0)::float AS total_weight
     FROM votes v
     JOIN messages m ON m.id = v.target_id AND v.target_type = 'message'
     WHERE m.account_id = $1 AND m.level = 1`,
    [accountId]
  );

  const contrib = contribRows[0];
  const reputationContribution = contrib.total_weight > 0
    ? (contrib.up_weight - contrib.down_weight) / contrib.total_weight
    : 0;

  // Policing reputation: votes on level-2 messages by this account
  const { rows: policingRows } = await pool.query(
    `SELECT
       COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'up'), 0)::float AS up_weight,
       COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'down'), 0)::float AS down_weight,
       COALESCE(SUM(v.weight), 0)::float AS total_weight
     FROM votes v
     JOIN messages m ON m.id = v.target_id AND v.target_type = 'message'
     WHERE m.account_id = $1 AND m.level = 2`,
    [accountId]
  );

  const policing = policingRows[0];
  const reputationPolicing = policing.total_weight > 0
    ? (policing.up_weight - policing.down_weight) / policing.total_weight
    : 0;

  // Update account
  await pool.query(
    'UPDATE accounts SET reputation_contribution = $1, reputation_policing = $2 WHERE id = $3',
    [reputationContribution, reputationPolicing, accountId]
  );

  return { reputationContribution, reputationPolicing };
}

/**
 * Check and update badge eligibility for an account.
 * Criteria for each badge:
 * - >85% positive weight ratio
 * - 3+ distinct topics
 * - 30+ days since account created_at
 * - Zero active flags on the account
 */
async function checkBadges(accountId) {
  const pool = getPool();

  // Get account
  const { rows: accountRows } = await pool.query(
    'SELECT id, created_at FROM accounts WHERE id = $1',
    [accountId]
  );
  if (accountRows.length === 0) {
    throw Object.assign(new Error('Account not found'), { code: 'NOT_FOUND' });
  }
  const account = accountRows[0];

  // Check account age >= 30 days
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const accountAge = Date.now() - new Date(account.created_at).getTime();
  const oldEnough = accountAge >= thirtyDaysMs;

  // Check active flags
  const { rows: flagRows } = await pool.query(
    `SELECT COUNT(*)::int AS flag_count
     FROM messages
     WHERE type = 'flag' AND content LIKE '%' || $1 || '%' AND status != 'resolved'`,
    [accountId]
  );
  const hasFlags = flagRows[0].flag_count > 0;

  // --- Contribution badge (level-1 messages) ---
  const { rows: contribVoteRows } = await pool.query(
    `SELECT
       COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'up'), 0)::float AS up_weight,
       COALESCE(SUM(v.weight), 0)::float AS total_weight
     FROM votes v
     JOIN messages m ON m.id = v.target_id AND v.target_type = 'message'
     WHERE m.account_id = $1 AND m.level = 1`,
    [accountId]
  );
  const contribUp = contribVoteRows[0].up_weight;
  const contribTotal = contribVoteRows[0].total_weight;
  const contribPositiveRatio = contribTotal > 0 ? contribUp / contribTotal : 0;

  // Distinct topics for contribution
  const { rows: contribTopicRows } = await pool.query(
    `SELECT COUNT(DISTINCT m.topic_id)::int AS topic_count
     FROM messages m
     WHERE m.account_id = $1 AND m.level = 1`,
    [accountId]
  );
  const contribTopicCount = contribTopicRows[0].topic_count;

  const badgeContribution = oldEnough && !hasFlags
    && contribPositiveRatio > 0.85 && contribTopicCount >= 3;

  // --- Policing badge (level-2 messages) ---
  const { rows: policingVoteRows } = await pool.query(
    `SELECT
       COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'up'), 0)::float AS up_weight,
       COALESCE(SUM(v.weight), 0)::float AS total_weight
     FROM votes v
     JOIN messages m ON m.id = v.target_id AND v.target_type = 'message'
     WHERE m.account_id = $1 AND m.level = 2`,
    [accountId]
  );
  const policingUp = policingVoteRows[0].up_weight;
  const policingTotal = policingVoteRows[0].total_weight;
  const policingPositiveRatio = policingTotal > 0 ? policingUp / policingTotal : 0;

  // Distinct topics for policing
  const { rows: policingTopicRows } = await pool.query(
    `SELECT COUNT(DISTINCT m.topic_id)::int AS topic_count
     FROM messages m
     WHERE m.account_id = $1 AND m.level = 2`,
    [accountId]
  );
  const policingTopicCount = policingTopicRows[0].topic_count;

  const badgePolicing = oldEnough && !hasFlags
    && policingPositiveRatio > 0.85 && policingTopicCount >= 3;

  // Update badges
  await pool.query(
    'UPDATE accounts SET badge_contribution = $1, badge_policing = $2 WHERE id = $3',
    [badgeContribution, badgePolicing, accountId]
  );

  return { badgeContribution, badgePolicing };
}

/**
 * Batch recalculate reputation and badges for all active accounts.
 */
async function recalculateAll() {
  const pool = getPool();
  const { rows: accounts } = await pool.query(
    "SELECT id FROM accounts WHERE status = 'active'"
  );

  const results = [];
  for (const account of accounts) {
    const reputation = await recalculateReputation(account.id);
    const badges = await checkBadges(account.id);
    results.push({ accountId: account.id, ...reputation, ...badges });
  }

  return results;
}

/**
 * Get detailed reputation info for an account.
 */
async function getReputationDetails(accountId) {
  const pool = getPool();

  // Get account
  const { rows: accountRows } = await pool.query(
    `SELECT reputation_contribution, reputation_policing, badge_contribution, badge_policing
     FROM accounts WHERE id = $1`,
    [accountId]
  );
  if (accountRows.length === 0) {
    throw Object.assign(new Error('Account not found'), { code: 'NOT_FOUND' });
  }
  const account = accountRows[0];

  // Count votes on contribution messages
  const { rows: contribRows } = await pool.query(
    `SELECT COUNT(*)::int AS vote_count
     FROM votes v
     JOIN messages m ON m.id = v.target_id AND v.target_type = 'message'
     WHERE m.account_id = $1 AND m.level = 1`,
    [accountId]
  );

  // Distinct topics for contribution
  const { rows: contribTopicRows } = await pool.query(
    `SELECT COUNT(DISTINCT m.topic_id)::int AS topic_count
     FROM messages m
     WHERE m.account_id = $1 AND m.level = 1`,
    [accountId]
  );

  // Count votes on policing messages
  const { rows: policingRows } = await pool.query(
    `SELECT COUNT(*)::int AS vote_count
     FROM votes v
     JOIN messages m ON m.id = v.target_id AND v.target_type = 'message'
     WHERE m.account_id = $1 AND m.level = 2`,
    [accountId]
  );

  return {
    contribution: {
      score: account.reputation_contribution || 0,
      voteCount: contribRows[0].vote_count,
      topicCount: contribTopicRows[0].topic_count,
    },
    policing: {
      score: account.reputation_policing || 0,
      voteCount: policingRows[0].vote_count,
    },
    badges: {
      contribution: account.badge_contribution || false,
      policing: account.badge_policing || false,
    },
  };
}

module.exports = {
  recalculateReputation,
  checkBadges,
  recalculateAll,
  getReputationDetails,
};
