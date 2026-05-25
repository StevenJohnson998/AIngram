/**
 * Reputation service — calculate reputation scores and badge eligibility.
 * Badge thresholds and trust parameters defined in src/config/trust.js.
 */

const { getPool } = require('../config/database');
const trustConfig = require('../config/trust');
const { getTierName } = require('../domain');

/**
 * Recalculate reputation_contribution and reputation_policing for an account.
 * Uses Beta Reputation model (Josang 2002) + Momentum + Sanction Penalties:
 *   α = prior + Σ(up_weights) + momentum
 *   β = prior + Σ(down_weights) + sanction_penalty
 *   reputation = α / (α + β)   // range [0, 1]
 *
 * Momentum rewards consistent publishing activity (cold-start bootstrap).
 * Sanction penalties increase β based on validated flags and sanctions,
 * with linear decay over time (except bans which never decay).
 *
 * - contribution = votes on level-1 messages + momentum - penalties
 * - policing = votes on level-2 messages (no momentum, no penalties)
 */
async function recalculateReputation(accountId) {
  const pool = getPool();
  const priorA = trustConfig.REP_PRIOR_ALPHA;
  const priorB = trustConfig.REP_PRIOR_BETA;

  // Contribution reputation: votes on level-1 messages by this account
  const votePromise = pool.query(
    `SELECT
       COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'up'), 0)::float AS up_weight,
       COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'down'), 0)::float AS down_weight
     FROM votes v
     JOIN messages m ON m.id = v.target_id AND v.target_type = 'message'
     WHERE m.account_id = $1 AND m.level = 1`,
    [accountId]
  );

  // Contribution momentum: published chunks with daily/weekly rate caps
  const momentumPromise = pool.query(
    `WITH daily AS (
       SELECT
         DATE(c.created_at) AS day,
         DATE_TRUNC('week', c.created_at) AS week,
         LEAST(COUNT(*)::int, $2) AS day_chunks,
         LEAST(COUNT(*) FILTER (WHERE cs.source_count > 0)::int, $2) AS day_sourced
       FROM chunks c
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS source_count FROM chunk_sources WHERE chunk_id = c.id
       ) cs ON true
       WHERE c.created_by = $1 AND c.status = 'published'
       GROUP BY DATE(c.created_at), DATE_TRUNC('week', c.created_at)
     ),
     weekly AS (
       SELECT
         week,
         LEAST(SUM(day_chunks)::int, $3) AS week_chunks,
         LEAST(SUM(day_sourced)::int, $3) AS week_sourced
       FROM daily
       GROUP BY week
     )
     SELECT
       COALESCE(SUM(week_chunks), 0)::int AS effective_chunks,
       COALESCE(SUM(week_sourced), 0)::int AS effective_sourced
     FROM weekly`,
    [accountId, trustConfig.MOMENTUM_DAILY_CAP, trustConfig.MOMENTUM_WEEKLY_CAP]
  );

  // Policing reputation: votes on level-2 messages by this account
  const policingPromise = pool.query(
    `SELECT
       COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'up'), 0)::float AS up_weight,
       COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'down'), 0)::float AS down_weight
     FROM votes v
     JOIN messages m ON m.id = v.target_id AND v.target_type = 'message'
     WHERE m.account_id = $1 AND m.level = 2`,
    [accountId]
  );

  // Sanction penalty: validated flags + sanctions with linear time decay
  const penaltyPromise = pool.query(
    `SELECT COALESCE(SUM(penalty), 0)::float AS total_penalty FROM (
       SELECT $2 * GREATEST(0, 1.0 - EXTRACT(EPOCH FROM (now() - f.created_at)) / ($3 * 86400))
              AS penalty
       FROM flags f
       WHERE f.target_type = 'account' AND f.target_id = $1 AND f.status = 'actioned'
       UNION ALL
       SELECT CASE s.type
                WHEN 'ban' THEN $4
                WHEN 'vote_suspension' THEN $5 * GREATEST(0, 1.0 - EXTRACT(EPOCH FROM (now() - s.issued_at)) / ($6 * 86400))
                ELSE 0
              END AS penalty
       FROM sanctions s
       WHERE s.account_id = $1
     ) sub`,
    [
      accountId,
      trustConfig.PENALTY_FLAG,
      trustConfig.PENALTY_FLAG_DECAY_DAYS,
      trustConfig.PENALTY_BAN,
      trustConfig.PENALTY_SUSPENSION,
      trustConfig.PENALTY_SUSPENSION_DECAY_DAYS,
    ]
  );

  const [contribResult, momentumResult, policingResult, penaltyResult] = await Promise.all([
    votePromise, momentumPromise, policingPromise, penaltyPromise,
  ]);

  const contrib = contribResult.rows[0];
  const { effective_chunks, effective_sourced } = momentumResult.rows[0];
  const momentum = Math.min(
    trustConfig.MOMENTUM_CAP,
    effective_chunks * trustConfig.MOMENTUM_PER_CHUNK
      + effective_sourced * trustConfig.MOMENTUM_PER_SOURCE
  );
  const sanctionPenalty = penaltyResult.rows[0].total_penalty;

  const contribAlpha = priorA + contrib.up_weight + momentum;
  const contribBeta = priorB + contrib.down_weight + sanctionPenalty;
  const reputationContribution = contribAlpha / (contribAlpha + contribBeta);

  const policing = policingResult.rows[0];
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

  // Query 1: account data (age + elite fields + lock flag)
  const accountPromise = pool.query(
    'SELECT id, created_at, reputation_contribution, badge_contribution, badge_policing, badge_elite, badges_locked FROM accounts WHERE id = $1',
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

  if (account.badges_locked) {
    return { badgeContribution: !!account.badge_contribution, badgePolicing: !!account.badge_policing, badgeElite: !!account.badge_elite, locked: true };
  }

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

  // --- Contribution badge: account reputation + topic breadth ---
  const badgeContribution = oldEnough && !hasFlags
    && (account.reputation_contribution || 0) >= trustConfig.BADGE_MIN_POSITIVE_RATIO
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
    `SELECT reputation_contribution, reputation_policing, badge_contribution, badge_policing, badge_elite, tier, interaction_count, created_at
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
    tier: account.tier || 0,
    tierName: getTierName(account.tier || 0),
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

async function propagateChunkTrustBatched({ batchSize = 50, pauseMs = 50 } = {}) {
  const pool = getPool();
  const { rows: chunks } = await pool.query(
    "SELECT id FROM chunks WHERE status NOT IN ('retracted', 'deleted')"
  );

  let updated = 0;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    for (const chunk of batch) {
      try {
        await recalculateChunkTrust(chunk.id);
        updated++;
      } catch (err) {
        console.error(`Chunk trust propagation failed for ${chunk.id}:`, err.message);
      }
    }
    if (i + batchSize < chunks.length) {
      await new Promise(resolve => setTimeout(resolve, pauseMs));
    }
  }

  return { updated };
}

module.exports = {
  recalculateReputation,
  checkBadges,
  recalculateAll,
  recalculateAllBatched,
  getReputationDetails,
  recalculateChunkTrust,
  propagateChunkTrustBatched,
  awardDeliberationBonus,
  awardDissentBonus,
};
