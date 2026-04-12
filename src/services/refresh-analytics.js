/**
 * Refresh analytics — gaming detection and reputation breakdown.
 * Instance admin only (enforced at route level).
 */

const { getPool } = require('../config/database');

/**
 * Per-agent refresh stats with gaming signals.
 * Returns one row per agent who has done at least one refresh action.
 */
async function getAgentRefreshStats() {
  const pool = getPool();

  const { rows } = await pool.query(`
    WITH refresh_actions AS (
      SELECT
        al.account_id,
        a.name AS account_name,
        a.type AS account_type,
        al.action,
        al.target_id,
        al.metadata,
        al.created_at
      FROM activity_log al
      JOIN accounts a ON a.id = al.account_id
      WHERE al.action IN ('article_refreshed', 'chunk_verified', 'chunk_refresh_updated')
    ),
    per_agent AS (
      SELECT
        account_id,
        account_name,
        account_type,
        -- Total refresh actions (article-level)
        COUNT(*) FILTER (WHERE action = 'article_refreshed') AS total_refreshes,
        -- Operation counts
        COUNT(*) FILTER (WHERE action = 'chunk_verified') AS verify_count,
        COUNT(*) FILTER (WHERE action = 'chunk_refresh_updated') AS update_count,
        -- Unique topics refreshed
        COUNT(DISTINCT target_id) FILTER (WHERE action = 'article_refreshed') AS unique_topics,
        -- Evidence quality: verify ops with no evidence
        COUNT(*) FILTER (
          WHERE action = 'chunk_verified'
          AND (metadata IS NULL OR metadata->>'evidence' IS NULL OR metadata->>'evidence' = 'null')
        ) AS hollow_verify_count,
        -- Date range
        MIN(created_at) AS first_refresh_at,
        MAX(created_at) AS last_refresh_at,
        -- Activity in last 24h
        COUNT(*) FILTER (
          WHERE action = 'article_refreshed'
          AND created_at > NOW() - INTERVAL '24 hours'
        ) AS refreshes_last_24h
      FROM refresh_actions
      GROUP BY account_id, account_name, account_type
    )
    SELECT
      pa.*,
      a.reputation_contribution,
      -- Computed signals
      CASE WHEN pa.verify_count > 0
        THEN ROUND(pa.hollow_verify_count::numeric / pa.verify_count, 2)
        ELSE 0 END AS hollow_verify_rate,
      CASE WHEN pa.total_refreshes > 0
        THEN ROUND(pa.unique_topics::numeric / pa.total_refreshes, 2)
        ELSE 0 END AS topic_diversity_rate,
      -- Days active
      CASE WHEN pa.first_refresh_at IS NOT NULL AND pa.last_refresh_at IS NOT NULL
        THEN GREATEST(1, EXTRACT(EPOCH FROM (pa.last_refresh_at - pa.first_refresh_at)) / 86400)
        ELSE 1 END AS active_days
    FROM per_agent pa
    JOIN accounts a ON a.id = pa.account_id
    ORDER BY pa.total_refreshes DESC
  `);

  return rows.map(row => {
    const activeDays = parseFloat(row.active_days) || 1;
    const velocity = row.total_refreshes / activeDays;

    return {
      accountId: row.account_id,
      accountName: row.account_name,
      accountType: row.account_type,
      reputationContribution: parseFloat(row.reputation_contribution) || 0,
      stats: {
        totalRefreshes: row.total_refreshes,
        verifyCount: row.verify_count,
        updateCount: row.update_count,
        uniqueTopics: row.unique_topics,
        hollowVerifyCount: row.hollow_verify_count,
        firstRefreshAt: row.first_refresh_at,
        lastRefreshAt: row.last_refresh_at,
        refreshesLast24h: row.refreshes_last_24h,
      },
      signals: {
        hollowVerifyRate: parseFloat(row.hollow_verify_rate),
        topicDiversityRate: parseFloat(row.topic_diversity_rate),
        velocity: Math.round(velocity * 100) / 100,
      },
      alerts: buildAlerts(row, velocity),
    };
  });
}

/**
 * Build alert flags from stats.
 */
function buildAlerts(row, velocity) {
  const alerts = [];
  const hvr = parseFloat(row.hollow_verify_rate);
  const tdr = parseFloat(row.topic_diversity_rate);

  if (hvr > 0.8 && row.verify_count >= 5) {
    alerts.push({ signal: 'hollow_verify', severity: 'high', detail: `${Math.round(hvr * 100)}% of verifications have no evidence (${row.hollow_verify_count}/${row.verify_count})` });
  } else if (hvr > 0.5 && row.verify_count >= 3) {
    alerts.push({ signal: 'hollow_verify', severity: 'medium', detail: `${Math.round(hvr * 100)}% of verifications have no evidence` });
  }

  if (tdr < 0.3 && row.total_refreshes >= 5) {
    alerts.push({ signal: 'low_topic_diversity', severity: 'high', detail: `Only ${row.unique_topics} unique topics across ${row.total_refreshes} refreshes` });
  }

  if (velocity > 5) {
    alerts.push({ signal: 'high_velocity', severity: 'high', detail: `${velocity.toFixed(1)} refreshes/day average` });
  } else if (velocity > 3) {
    alerts.push({ signal: 'high_velocity', severity: 'medium', detail: `${velocity.toFixed(1)} refreshes/day average` });
  }

  if (row.update_count === 0 && row.total_refreshes >= 3) {
    alerts.push({ signal: 'verify_only', severity: 'low', detail: `${row.total_refreshes} refreshes, 0 updates -- never found anything to change` });
  }

  return alerts;
}

/**
 * Recent refresh activity log (last N actions).
 */
async function getRecentRefreshActivity(limit = 50) {
  const pool = getPool();

  const { rows } = await pool.query(`
    SELECT
      al.id, al.account_id, a.name AS account_name,
      al.action, al.target_type, al.target_id,
      al.metadata, al.created_at,
      CASE WHEN al.action = 'article_refreshed'
        THEN t.title ELSE NULL END AS topic_title
    FROM activity_log al
    JOIN accounts a ON a.id = al.account_id
    LEFT JOIN topics t ON t.id = al.target_id AND al.target_type = 'topic'
    WHERE al.action IN ('article_refreshed', 'chunk_verified', 'chunk_refresh_updated')
    ORDER BY al.created_at DESC
    LIMIT $1
  `, [limit]);

  return rows;
}

/**
 * Reputation breakdown by source type for an account.
 * Reconstructs where reputation_contribution came from.
 */
async function getReputationBreakdown(accountId) {
  const pool = getPool();

  // Refresh-related reputation (from activity_log)
  const { rows: refreshRows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE action = 'chunk_verified')::int AS refresh_verify_count,
      COUNT(*) FILTER (WHERE action = 'chunk_refresh_updated')::int AS refresh_update_count
    FROM activity_log
    WHERE account_id = $1
      AND action IN ('chunk_verified', 'chunk_refresh_updated')
  `, [accountId]);

  // Deliberation bonuses
  const { rows: delibRows } = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM activity_log
    WHERE action = 'deliberation_bonus'
      AND metadata::text LIKE $1
  `, [`%${accountId}%`]);

  // Dissent bonuses
  const { rows: dissentRows } = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM activity_log
    WHERE action = 'dissent_bonus'
      AND metadata::text LIKE $1
  `, [`%${accountId}%`]);

  // Dismissed flags (negative reputation)
  const { rows: dismissedRows } = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM chunk_refresh_flags
    WHERE flagged_by = $1 AND status = 'dismissed'
  `, [accountId]);

  // Votes received on account's messages (the Beta model source)
  const { rows: voteRows } = await pool.query(`
    SELECT
      COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'up'), 0)::float AS up_weight,
      COALESCE(SUM(v.weight) FILTER (WHERE v.value = 'down'), 0)::float AS down_weight,
      COUNT(*)::int AS total_votes
    FROM votes v
    JOIN messages m ON m.id = v.target_id AND v.target_type = 'message'
    WHERE m.account_id = $1 AND m.level = 1
  `, [accountId]);

  // Get current reputation
  const { rows: acctRows } = await pool.query(
    'SELECT reputation_contribution FROM accounts WHERE id = $1',
    [accountId]
  );

  const { DELTA_REFRESH_VERIFY, DELTA_REFRESH_UPDATE, DELTA_REFRESH_FLAG_INVALID } = require('../../build/config/protocol');
  const { DELTA_DELIB, DELTA_DISSENT } = require('../../build/config/protocol');

  const r = refreshRows[0];
  const refreshVerifyDelta = r.refresh_verify_count * DELTA_REFRESH_VERIFY;
  const refreshUpdateDelta = r.refresh_update_count * DELTA_REFRESH_UPDATE;
  const delibDelta = delibRows[0].count * DELTA_DELIB;
  const dissentDelta = dissentRows[0].count * DELTA_DISSENT;
  const flagInvalidDelta = dismissedRows[0].count * DELTA_REFRESH_FLAG_INVALID;
  const totalDelta = refreshVerifyDelta + refreshUpdateDelta + delibDelta + dissentDelta + flagInvalidDelta;

  const currentRep = parseFloat(acctRows[0]?.reputation_contribution) || 0;

  // Beta model portion (from votes)
  const betaPortion = Math.max(0, currentRep - totalDelta);

  const sources = {
    betaModel: { portion: betaPortion, detail: `${voteRows[0].total_votes} votes (${voteRows[0].up_weight.toFixed(2)} up / ${voteRows[0].down_weight.toFixed(2)} down)` },
    refreshVerify: { delta: refreshVerifyDelta, count: r.refresh_verify_count, detail: `${r.refresh_verify_count} verifications x ${DELTA_REFRESH_VERIFY}` },
    refreshUpdate: { delta: refreshUpdateDelta, count: r.refresh_update_count, detail: `${r.refresh_update_count} updates x ${DELTA_REFRESH_UPDATE}` },
    deliberation: { delta: delibDelta, count: delibRows[0].count, detail: `${delibRows[0].count} bonuses x ${DELTA_DELIB}` },
    dissent: { delta: dissentDelta, count: dissentRows[0].count, detail: `${dissentRows[0].count} bonuses x ${DELTA_DISSENT}` },
    flagInvalid: { delta: flagInvalidDelta, count: dismissedRows[0].count, detail: `${dismissedRows[0].count} dismissed flags x ${DELTA_REFRESH_FLAG_INVALID}` },
  };

  // Percentages
  const absTotal = Math.abs(betaPortion) + Math.abs(refreshVerifyDelta) + Math.abs(refreshUpdateDelta) + Math.abs(delibDelta) + Math.abs(dissentDelta) + Math.abs(flagInvalidDelta);
  const pct = (v) => absTotal > 0 ? Math.round(Math.abs(v) / absTotal * 100) : 0;

  return {
    accountId,
    currentReputation: currentRep,
    breakdown: {
      betaModel: { ...sources.betaModel, pct: pct(betaPortion) },
      refreshVerify: { ...sources.refreshVerify, pct: pct(refreshVerifyDelta) },
      refreshUpdate: { ...sources.refreshUpdate, pct: pct(refreshUpdateDelta) },
      deliberation: { ...sources.deliberation, pct: pct(delibDelta) },
      dissent: { ...sources.dissent, pct: pct(dissentDelta) },
      flagInvalid: { ...sources.flagInvalid, pct: pct(flagInvalidDelta) },
    },
    totalDeltaApplied: totalDelta,
  };
}

/**
 * Full report: all agents + breakdowns + alerts.
 * Not exposed via API -- called by scripts/refresh-report.js
 */
async function generateFullReport() {
  const agentStats = await getAgentRefreshStats();
  const recentActivity = await getRecentRefreshActivity(20);

  // Get reputation breakdown for each agent with refresh activity
  const breakdowns = {};
  for (const agent of agentStats) {
    breakdowns[agent.accountId] = await getReputationBreakdown(agent.accountId);
  }

  // Global stats
  const pool = getPool();
  const { rows: globalRows } = await pool.query(`
    SELECT
      COUNT(DISTINCT al.account_id)::int AS total_refreshers,
      COUNT(*) FILTER (WHERE al.action = 'article_refreshed')::int AS total_refreshes,
      COUNT(*) FILTER (WHERE al.action = 'chunk_verified')::int AS total_verifications,
      COUNT(*) FILTER (WHERE al.action = 'chunk_refresh_updated')::int AS total_updates,
      COUNT(DISTINCT al.target_id) FILTER (WHERE al.action = 'article_refreshed')::int AS topics_refreshed
    FROM activity_log al
    WHERE al.action IN ('article_refreshed', 'chunk_verified', 'chunk_refresh_updated')
  `);

  const { rows: flagRows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'addressed')::int AS addressed,
      COUNT(*) FILTER (WHERE status = 'dismissed')::int AS dismissed
    FROM chunk_refresh_flags
  `);

  const alertAgents = agentStats.filter(a => a.alerts.length > 0);

  return {
    generatedAt: new Date().toISOString(),
    global: {
      ...globalRows[0],
      flags: flagRows[0],
    },
    alerts: {
      agentsWithAlerts: alertAgents.length,
      details: alertAgents.map(a => ({
        accountName: a.accountName,
        accountId: a.accountId,
        alerts: a.alerts,
      })),
    },
    agents: agentStats.map(a => ({
      ...a,
      reputationBreakdown: breakdowns[a.accountId]?.breakdown || null,
    })),
    recentActivity: recentActivity.slice(0, 10),
  };
}

module.exports = {
  getAgentRefreshStats,
  getRecentRefreshActivity,
  getReputationBreakdown,
  generateFullReport,
};
