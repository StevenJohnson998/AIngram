/**
 * DMCA coordination detection — identifies coordinated false copyright campaigns.
 * Four heuristics: author targeting, Sybil accounts, report-only accounts, copy-paste claims.
 */

const { getPool } = require('../config/database');
const {
  DMCA_COORDINATION_WINDOW_MS,
  DMCA_COORDINATION_MIN_REPORTERS,
  DMCA_CLAIM_SIMILARITY_THRESHOLD,
  DMCA_SYBIL_CREATION_WINDOW_HOURS,
} = require('../config/protocol');

/** Reuse Jaccard similarity from copyright-review (stop words + tokenizer) */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'and', 'but', 'or', 'not', 'no', 'so', 'if',
  'i', 'me', 'we', 'you', 'he', 'she', 'they', 'them',
]);

function jaccardSimilarity(textA, textB) {
  const tokenize = (t) => {
    const words = t.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    return new Set(words.filter((w) => w.length > 2 && !STOP_WORDS.has(w)));
  };
  const setA = tokenize(textA);
  const setB = tokenize(textB);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Detect coordination signals for a new copyright review.
 * @param {object} params
 * @param {string} params.chunkId - Chunk being reported
 * @param {string} params.reporterId - Account filing the report
 * @param {string} params.reason - Claim text
 * @returns {{ isCoordinated: boolean, signals: string[], details: object }}
 */
async function detectCoordination({ chunkId, reporterId, reason }) {
  const pool = getPool();
  const signals = [];
  const details = {};
  const windowHours = Math.round(DMCA_COORDINATION_WINDOW_MS / (60 * 60 * 1000));

  // 1. Author targeting: multiple reporters vs same chunk author in window
  const { rows: authorRows } = await pool.query(
    `SELECT COUNT(DISTINCT cr.flagged_by)::int AS reporter_count
     FROM copyright_reviews cr
     JOIN chunks c ON c.id = cr.chunk_id
     WHERE c.created_by = (SELECT created_by FROM chunks WHERE id = $1)
       AND cr.created_at > now() - make_interval(hours => $2)
       AND cr.flagged_by IS NOT NULL
       AND cr.flagged_by != $3`,
    [chunkId, windowHours, reporterId]
  );
  // +1 for current reporter
  const totalReporters = (authorRows[0]?.reporter_count || 0) + 1;
  if (totalReporters >= DMCA_COORDINATION_MIN_REPORTERS) {
    signals.push('author_targeting');
    details.author_targeting = { reporter_count: totalReporters, window_hours: windowHours };
  }

  // 2. Sybil detection: reporters targeting same author created within X hours of each other
  if (reporterId) {
    const { rows: reporterRows } = await pool.query(
      `SELECT a.id, a.created_at FROM accounts a
       WHERE a.id IN (
         SELECT DISTINCT cr.flagged_by FROM copyright_reviews cr
         JOIN chunks c ON c.id = cr.chunk_id
         WHERE c.created_by = (SELECT created_by FROM chunks WHERE id = $1)
           AND cr.created_at > now() - make_interval(hours => $2)
           AND cr.flagged_by IS NOT NULL
       )
       UNION
       SELECT a.id, a.created_at FROM accounts a WHERE a.id = $3`,
      [chunkId, windowHours, reporterId]
    );

    if (reporterRows.length >= 2) {
      // Check pairwise creation-time proximity
      let sybilPairs = 0;
      const windowMs = DMCA_SYBIL_CREATION_WINDOW_HOURS * 60 * 60 * 1000;
      for (let i = 0; i < reporterRows.length; i++) {
        for (let j = i + 1; j < reporterRows.length; j++) {
          const diff = Math.abs(
            new Date(reporterRows[i].created_at).getTime() - new Date(reporterRows[j].created_at).getTime()
          );
          if (diff <= windowMs) sybilPairs++;
        }
      }
      if (sybilPairs > 0) {
        signals.push('sybil_accounts');
        details.sybil_accounts = { pairs_detected: sybilPairs, creation_window_hours: DMCA_SYBIL_CREATION_WINDOW_HOURS };
      }
    }
  }

  // 3. Report-only account: reporter has no contributions and no messages
  if (reporterId) {
    const { rows: activityRows } = await pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM chunks WHERE created_by = $1) AS chunk_count,
        (SELECT COUNT(*)::int FROM messages WHERE account_id = $1) AS message_count`,
      [reporterId]
    );
    if (activityRows[0]?.chunk_count === 0 && activityRows[0]?.message_count === 0) {
      signals.push('report_only_account');
      details.report_only_account = { reporter_id: reporterId };
    }
  }

  // 4. Copy-paste claims: similar reason text from different reporters in window
  if (reason && reporterId) {
    const { rows: recentClaims } = await pool.query(
      `SELECT cr.reason, cr.flagged_by FROM copyright_reviews cr
       JOIN chunks c ON c.id = cr.chunk_id
       WHERE c.created_by = (SELECT created_by FROM chunks WHERE id = $1)
         AND cr.created_at > now() - make_interval(hours => $2)
         AND cr.flagged_by IS NOT NULL
         AND cr.flagged_by != $3`,
      [chunkId, windowHours, reporterId]
    );

    const similarClaims = recentClaims.filter(
      (claim) => jaccardSimilarity(claim.reason, reason) >= DMCA_CLAIM_SIMILARITY_THRESHOLD
    );
    if (similarClaims.length > 0) {
      signals.push('copy_paste_claims');
      details.copy_paste_claims = { similar_count: similarClaims.length, threshold: DMCA_CLAIM_SIMILARITY_THRESHOLD };
    }
  }

  return {
    isCoordinated: signals.length > 0,
    signals,
    details,
  };
}

/**
 * Get active coordination campaigns for analytics.
 */
async function getCoordinationAnalytics() {
  const pool = getPool();
  const windowHours = Math.round(DMCA_COORDINATION_WINDOW_MS / (60 * 60 * 1000));

  // Active campaigns: authors targeted by multiple reporters
  const { rows: campaigns } = await pool.query(
    `SELECT c.created_by AS target_author_id,
            a.name AS target_author_name,
            COUNT(DISTINCT cr.flagged_by)::int AS reporter_count,
            COUNT(cr.id)::int AS report_count,
            MIN(cr.created_at) AS first_report_at,
            MAX(cr.created_at) AS last_report_at
     FROM copyright_reviews cr
     JOIN chunks c ON c.id = cr.chunk_id
     JOIN accounts a ON a.id = c.created_by
     WHERE cr.created_at > now() - make_interval(hours => $1)
       AND cr.flagged_by IS NOT NULL
     GROUP BY c.created_by, a.name
     HAVING COUNT(DISTINCT cr.flagged_by) >= $2
     ORDER BY reporter_count DESC`,
    [windowHours, DMCA_COORDINATION_MIN_REPORTERS]
  );

  // Count total flagged reviews
  const { rows: flaggedRows } = await pool.query(
    'SELECT COUNT(*)::int AS total FROM copyright_reviews WHERE coordination_flag = true'
  );

  // Report-only accounts
  const { rows: reportOnlyRows } = await pool.query(
    `SELECT COUNT(DISTINCT cr.flagged_by)::int AS total
     FROM copyright_reviews cr
     WHERE cr.flagged_by IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM chunks WHERE created_by = cr.flagged_by)
       AND NOT EXISTS (SELECT 1 FROM messages WHERE account_id = cr.flagged_by)`
  );

  return {
    data: {
      active_campaigns: campaigns,
      flagged_reviews: flaggedRows[0].total,
      report_only_accounts: reportOnlyRows[0].total,
    },
  };
}

module.exports = {
  detectCoordination,
  getCoordinationAnalytics,
  jaccardSimilarity,
};
