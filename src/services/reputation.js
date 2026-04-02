/**
 * Reputation service — calculate reputation scores and badge eligibility.
 * Badge thresholds and trust parameters defined in src/config/trust.js.
 */

const { getPool } = require('../config/database');
const trustConfig = require('../config/trust');

/**
 * Recalculate reputation_contribution and reputation_policing for an account.
 * Uses Beta Reputation model (Josang 2002):
 *   α = prior + Σ(up_weights), β = prior + Σ(down_weights)
 *   reputation = α / (α + β)   // range [0, 1]
 * - contribution = votes on account's level-1 messages
 * - policing = votes on account's level-2 messages
 */
async function recalculateReputation(accountId) {
  const pool = getPool();
  const priorA = trustConfig.REP_PRIOR_ALPHA;
  const priorB = trustConfig.REP_PRIOR_BETA;

  // Contribution reputation: votes on level-1 messages by this account
  const { rows: contribRows } = await pool.query(
    `SELECT
       COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'up'), 0)::float AS up_weight,
       COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'down'), 0)::float AS down_weight
     FROM votes v
     JOIN messages m ON m.id = v.target_id AND v.target_type = 'message'
     WHERE m.account_id = $1 AND m.level = 1`,
    [accountId]
  );

  const contrib = contribRows[0];
  const contribAlpha = priorA + contrib.up_weight;
  const contribBeta = priorB + contrib.down_weight;
  const reputationContribution = contribAlpha / (contribAlpha + contribBeta);

  // Policing reputation: votes on level-2 messages by this account
  const { rows: policingRows } = await pool.query(
    `SELECT
       COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'up'), 0)::float AS up_weight,
       COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'down'), 0)::float AS down_weight
     FROM votes v
     JOIN messages m ON m.id = v.target_id AND v.target_type = 'message'
     WHERE m.account_id = $1 AND m.level = 2`,
    [accountId]
  );

  const policing = policingRows[0];
  const policingAlpha = priorA + policing.up_weight;
  const policingBeta = priorB + policing.down_weight;
  const reputationPolicing = policingAlpha / (policingAlpha + policingBeta);

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

  // Query 1: account data (age + elite fields) — merged from 2 former queries
  const accountPromise = pool.query(
    'SELECT id, created_at, reputation_contribution, badge_contribution FROM accounts WHERE id = $1',
    [accountId]
  );

  // Query 2: active flags
  const flagPromise = pool.query(
    `SELECT COUNT(*)::int AS flag_count
     FROM messages
     WHERE type = 'flag' AND content LIKE '%' || $1 || '%' AND status != 'resolved'`,
    [accountId]
  );

  // Query 3: votes + topics for level 1 and 2 in one pass
  const statsPromise = pool.query(
    `SELECT
       m.level,
       COUNT(DISTINCT m.topic_id)::int AS topic_count,
       COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'up'), 0)::float AS up_weight,
       COALESCE(SUM(v.weight), 0)::float AS total_weight
     FROM messages m
     LEFT JOIN votes v ON v.target_id = m.id AND v.target_type = 'message'
     WHERE m.account_id = $1 AND m.level IN (1, 2)
     GROUP BY m.level`,
    [accountId]
  );

  const [accountResult, flagResult, statsResult] = await Promise.all([
    accountPromise, flagPromise, statsPromise,
  ]);

  if (accountResult.rows.length === 0) {
    throw Object.assign(new Error('Account not found'), { code: 'NOT_FOUND' });
  }
  const account = accountResult.rows[0];

  // Account age checks
  const badgeMinMs = trustConfig.BADGE_MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
  const accountAge = Date.now() - new Date(account.created_at).getTime();
  const oldEnough = accountAge >= badgeMinMs;

  const hasFlags = flagResult.rows[0].flag_count > 0;

  // Parse stats by level (default zeros if no rows for a level)
  const levelStats = { 1: { topic_count: 0, up_weight: 0, total_weight: 0 }, 2: { topic_count: 0, up_weight: 0, total_weight: 0 } };
  for (const row of statsResult.rows) {
    levelStats[row.level] = row;
  }

  // --- Contribution badge (level-1 messages) ---
  const contribPositiveRatio = levelStats[1].total_weight > 0
    ? levelStats[1].up_weight / levelStats[1].total_weight : 0;
  const badgeContribution = oldEnough && !hasFlags
    && contribPositiveRatio > trustConfig.BADGE_MIN_POSITIVE_RATIO
    && levelStats[1].topic_count >= trustConfig.BADGE_CONTRIBUTION_MIN_TOPICS;

  // --- Policing badge (level-2 messages) ---
  const policingPositiveRatio = levelStats[2].total_weight > 0
    ? levelStats[2].up_weight / levelStats[2].total_weight : 0;
  const badgePolicing = oldEnough && !hasFlags
    && policingPositiveRatio > trustConfig.BADGE_MIN_POSITIVE_RATIO
    && levelStats[2].topic_count >= trustConfig.BADGE_POLICING_MIN_TOPICS;

  // --- Elite badge ---
  const eliteMinMs = trustConfig.BADGE_ELITE_MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
  const oldEnoughForElite = accountAge >= eliteMinMs;
  const badgeElite = oldEnoughForElite && !hasFlags
    && badgeContribution
    && (account.reputation_contribution || 0) >= trustConfig.BADGE_ELITE_MIN_REPUTATION
    && levelStats[1].topic_count >= trustConfig.BADGE_ELITE_MIN_TOPICS;

  // Update badges
  await pool.query(
    'UPDATE accounts SET badge_contribution = $1, badge_policing = $2, badge_elite = $3 WHERE id = $4',
    [badgeContribution, badgePolicing, badgeElite, accountId]
  );

  return { badgeContribution, badgePolicing, badgeElite };
}

/**
 * Batch recalculate reputation and badges for all active accounts.
 * WARNING: This is the unbatched version — blocks the event loop for large account counts.
 * Use recalculateAllBatched for worker/background use.
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
 * Batched recalculation — processes accounts in chunks with pauses.
 * Designed for the worker process to avoid blocking the event loop.
 */
async function recalculateAllBatched({ batchSize = 50, pauseMs = 100 } = {}) {
  const pool = getPool();
  const { rows: accounts } = await pool.query(
    "SELECT id FROM accounts WHERE status = 'active'"
  );

  const results = [];
  for (let i = 0; i < accounts.length; i += batchSize) {
    const batch = accounts.slice(i, i + batchSize);
    for (const account of batch) {
      try {
        const reputation = await recalculateReputation(account.id);
        const badges = await checkBadges(account.id);
        results.push({ accountId: account.id, ...reputation, ...badges });
      } catch (err) {
        console.error(`Reputation recalc failed for ${account.id}:`, err.message);
      }
    }
    // Yield event loop between batches
    if (i + batchSize < accounts.length) {
      await new Promise(resolve => setTimeout(resolve, pauseMs));
    }
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
    `SELECT reputation_contribution, reputation_policing, badge_contribution, badge_policing, badge_elite
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
      elite: account.badge_elite || false,
    },
  };
}

/**
 * Recalculate trust_score for a chunk using Beta Reputation + sources + age decay.
 *
 * Formula:
 *   α = prior_α(contributor_tier) + Σ(up_weights * voter_rep_factor) + source_bonus
 *   β = prior_β + Σ(down_weights * voter_rep_factor)
 *   trust = (α / (α + β)) * age_decay
 *
 * EigenTrust: each vote is weighted by the voter's own reputation.
 * Source bonus: each verified source adds to α (evidence-based boost).
 * Age decay: exponential decay with configurable half-life.
 */
async function recalculateChunkTrust(chunkId) {
  const pool = getPool();

  // Get chunk metadata (contributor tier, age, creation date)
  const { rows: chunkRows } = await pool.query(
    `SELECT c.created_by, c.created_at,
            a.badge_elite, a.badge_contribution
     FROM chunks c
     JOIN accounts a ON a.id = c.created_by
     WHERE c.id = $1`,
    [chunkId]
  );
  if (chunkRows.length === 0) return 0;
  const chunk = chunkRows[0];

  // Determine contributor tier
  let tier = 'new';
  if (chunk.badge_elite) tier = 'elite';
  else if (chunk.badge_contribution) tier = 'established';

  const priors = {
    new: trustConfig.CHUNK_PRIOR_NEW,
    established: trustConfig.CHUNK_PRIOR_ESTABLISHED,
    elite: trustConfig.CHUNK_PRIOR_ELITE,
  };
  const [priorA, priorB] = priors[tier];

  // Source bonus
  const { rows: sourceRows } = await pool.query(
    'SELECT COUNT(*)::int AS source_count FROM chunk_sources WHERE chunk_id = $1',
    [chunkId]
  );
  const sourceBonus = Math.min(
    sourceRows[0].source_count * trustConfig.SOURCE_BONUS_PER_SOURCE,
    trustConfig.SOURCE_BONUS_CAP
  );

  // Votes with EigenTrust weighting (voter reputation amplifies vote weight)
  const { rows: voteRows } = await pool.query(
    `SELECT v.value, v.weight, COALESCE(a.reputation_contribution, 0.5) AS voter_rep
     FROM votes v
     LEFT JOIN accounts a ON a.id = v.account_id
     WHERE v.target_type = 'chunk' AND v.target_id = $1`,
    [chunkId]
  );

  let upW = 0, downW = 0;
  for (const v of voteRows) {
    const repFactor = trustConfig.VOTER_REP_BASE + v.voter_rep;
    const w = v.weight * repFactor;
    if (v.value === 'up') upW += w;
    else downW += w;
  }

  const alpha = priorA + upW + sourceBonus;
  const beta = priorB + downW;
  let trustScore = alpha / (alpha + beta);

  // Age decay
  const ageDays = (Date.now() - new Date(chunk.created_at).getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays > 0) {
    const decay = Math.exp(-Math.log(2) * ageDays / trustConfig.AGE_HALF_LIFE_DAYS);
    trustScore = Math.max(trustConfig.AGE_DECAY_FLOOR, trustScore * decay);
  }

  await pool.query(
    'UPDATE chunks SET trust_score = $1 WHERE id = $2',
    [trustScore, chunkId]
  );

  return trustScore;
}

/**
 * Award deliberation bonus to voters who participated in discussion before voting.
 * Called after tallyAndResolve() — fire-and-forget.
 */
async function awardDeliberationBonus(chunkId) {
  const pool = getPool();
  const { DELTA_DELIB } = require('../../build/config/protocol');

  // Get topic IDs for this chunk
  const { rows: topicRows } = await pool.query(
    'SELECT topic_id FROM chunk_topics WHERE chunk_id = $1',
    [chunkId]
  );
  if (topicRows.length === 0) return [];

  const topicIds = topicRows.map(r => r.topic_id);

  // Get revealed voters for this chunk
  const { rows: voters } = await pool.query(
    'SELECT DISTINCT account_id FROM formal_votes WHERE chunk_id = $1 AND revealed_at IS NOT NULL',
    [chunkId]
  );
  if (voters.length === 0) return [];

  const voterIds = voters.map(v => v.account_id);

  // Find voters who also posted in discussion on this topic
  const { rows: participants } = await pool.query(
    `SELECT DISTINCT account_id FROM activity_log
     WHERE action = 'discussion_post' AND target_type = 'topic'
       AND target_id = ANY($1) AND account_id = ANY($2)`,
    [topicIds, voterIds]
  );
  if (participants.length === 0) return [];

  const recipientIds = participants.map(p => p.account_id);

  // Award bonus (capped at 1.0)
  for (const accountId of recipientIds) {
    await pool.query(
      'UPDATE accounts SET reputation_contribution = LEAST(1.0, reputation_contribution + $1) WHERE id = $2',
      [DELTA_DELIB, accountId]
    );
  }

  // Log
  await pool.query(
    `INSERT INTO activity_log (action, target_type, target_id, metadata)
     VALUES ('deliberation_bonus', 'chunk', $1, $2)`,
    [chunkId, JSON.stringify({ recipients: recipientIds, bonus: DELTA_DELIB })]
  );

  return recipientIds;
}

/**
 * Award dissent bonus to minority voters later vindicated.
 * @param {string} chunkId - chunk that changed state
 * @param {'accept'|'reject'} vindicatedSide - which side was right
 */
async function awardDissentBonus(chunkId, vindicatedSide) {
  const pool = getPool();
  const { DELTA_DISSENT } = require('../../build/config/protocol');

  const targetVoteValue = vindicatedSide === 'reject' ? -1 : 1;

  // Find minority voters whose vote matched the vindicated side
  const { rows: minorityVoters } = await pool.query(
    'SELECT DISTINCT account_id FROM formal_votes WHERE chunk_id = $1 AND vote_value = $2 AND revealed_at IS NOT NULL',
    [chunkId, targetVoteValue]
  );
  if (minorityVoters.length === 0) return [];

  const recipientIds = minorityVoters.map(v => v.account_id);

  for (const accountId of recipientIds) {
    await pool.query(
      'UPDATE accounts SET reputation_contribution = LEAST(1.0, reputation_contribution + $1) WHERE id = $2',
      [DELTA_DISSENT, accountId]
    );
  }

  await pool.query(
    `INSERT INTO activity_log (action, target_type, target_id, metadata)
     VALUES ('dissent_bonus', 'chunk', $1, $2)`,
    [chunkId, JSON.stringify({ recipients: recipientIds, side: vindicatedSide, bonus: DELTA_DISSENT })]
  );

  return recipientIds;
}

module.exports = {
  recalculateReputation,
  checkBadges,
  recalculateAll,
  recalculateAllBatched,
  getReputationDetails,
  recalculateChunkTrust,
  awardDeliberationBonus,
  awardDissentBonus,
};
