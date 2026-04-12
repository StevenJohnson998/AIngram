'use strict';

const { getPool } = require('../config/database');
const securityConfig = require('./security-config');

/**
 * Record an injection detection and update the account's cumulative score.
 * Blocks the account if the score exceeds the threshold.
 *
 * @param {string} accountId
 * @param {{ score: number, flags: string[], suspicious: boolean }} detectionResult - from analyzeUserInput
 * @param {string} fieldType - e.g. 'discussion.content', 'message.content'
 * @param {string} [contentPreview] - first 200 chars for review context
 * @returns {Promise<{ blocked: boolean, score: number, newlyBlocked: boolean }>}
 */
async function recordDetection(accountId, detectionResult, fieldType, contentPreview) {
  const pool = getPool();
  const halfLife = securityConfig.getConfig('injection_half_life_ms');
  const threshold = securityConfig.getConfig('injection_block_threshold');
  const minLogged = securityConfig.getConfig('injection_min_score_logged');

  // 1. Get or create current score
  const existing = await pool.query(
    'SELECT score, updated_at, blocked_at, review_status FROM injection_scores WHERE account_id = $1',
    [accountId]
  );

  let currentScore = 0;
  let lastUpdated = new Date();
  let alreadyBlocked = false;

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    currentScore = row.score;
    lastUpdated = new Date(row.updated_at);
    alreadyBlocked = row.blocked_at !== null && (row.review_status === 'pending' || row.review_status === 'confirmed');
  }

  // 2. Apply exponential decay
  const elapsed = Date.now() - lastUpdated.getTime();
  const decayed = currentScore * Math.pow(0.5, elapsed / halfLife);

  // 3. Add new detection score
  const newScore = decayed + detectionResult.score;

  // 4. Log if above minimum threshold
  if (detectionResult.score >= minLogged) {
    await pool.query(
      `INSERT INTO injection_log (account_id, score, cumulative_score, content_preview, field_type, flags)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [accountId, detectionResult.score, newScore, (contentPreview || '').substring(0, 200), fieldType, detectionResult.flags || []]
    );
  }

  // 5. Check if we need to block
  let newlyBlocked = false;
  if (newScore >= threshold && !alreadyBlocked) {
    // Block and flag for review
    await pool.query(
      `INSERT INTO injection_scores (account_id, score, updated_at, blocked_at, review_status)
       VALUES ($1, $2, now(), now(), 'pending')
       ON CONFLICT (account_id) DO UPDATE SET
         score = $2, updated_at = now(), blocked_at = now(), review_status = 'pending'`,
      [accountId, newScore]
    );

    // Create flag for Guardian review
    try {
      await pool.query(
        `INSERT INTO flags (reporter_id, target_type, target_id, reason, detection_type)
         VALUES ($1, 'account', $1, $2, 'injection_auto')`,
        [accountId, `Cumulative injection score ${newScore.toFixed(2)} exceeded threshold ${threshold}. Recent flags: ${(detectionResult.flags || []).join(', ')}. Field: ${fieldType}`]
      );
    } catch (err) {
      console.error('[injection-tracker] Failed to create flag:', err.message);
    }

    newlyBlocked = true;
    console.warn(`[injection-tracker] BLOCKED account=${accountId.substring(0, 8)} score=${newScore.toFixed(2)} threshold=${threshold}`);
  } else {
    // Just update the score
    await pool.query(
      `INSERT INTO injection_scores (account_id, score, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (account_id) DO UPDATE SET
         score = $2, updated_at = now()`,
      [accountId, newScore]
    );
  }

  return { blocked: alreadyBlocked || newlyBlocked, score: newScore, newlyBlocked };
}

/**
 * Check if an account is blocked from discussion.
 * @param {string} accountId
 * @returns {Promise<boolean>}
 */
async function isBlocked(accountId) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT 1 FROM injection_scores
     WHERE account_id = $1 AND blocked_at IS NOT NULL AND review_status IN ('pending', 'confirmed')`,
    [accountId]
  );
  return result.rows.length > 0;
}

/**
 * Resolve a review (called by Guardian or admin).
 * @param {string} accountId
 * @param {'clean'|'confirmed'} verdict - clean = false positive (unblock), confirmed = real injection (ban stays)
 * @returns {Promise<void>}
 */
async function resolveReview(accountId, verdict) {
  const pool = getPool();
  if (verdict === 'clean') {
    await pool.query(
      `UPDATE injection_scores SET review_status = 'clean', blocked_at = NULL, score = 0, updated_at = now()
       WHERE account_id = $1`,
      [accountId]
    );
    // Dismiss the flag
    await pool.query(
      `UPDATE flags SET status = 'dismissed', resolved_at = now()
       WHERE target_type = 'account' AND target_id = $1 AND detection_type = 'injection_auto' AND status = 'open'`,
      [accountId]
    );
  } else if (verdict === 'confirmed') {
    await pool.query(
      `UPDATE injection_scores SET review_status = 'confirmed', updated_at = now()
       WHERE account_id = $1`,
      [accountId]
    );
    await pool.query(
      `UPDATE flags SET status = 'actioned', resolved_at = now()
       WHERE target_type = 'account' AND target_id = $1 AND detection_type = 'injection_auto' AND status = 'open'`,
      [accountId]
    );
  }
}

module.exports = { recordDetection, isBlocked, resolveReview };
