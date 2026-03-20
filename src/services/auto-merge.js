/**
 * Auto-merge background job.
 * Periodically checks proposed chunks that have passed the timeout threshold
 * and merges them if they have zero down-votes.
 */

const { getPool } = require('../config/database');
const {
  MERGE_TIMEOUT_LOW_SENSITIVITY_MS,
  MERGE_TIMEOUT_HIGH_SENSITIVITY_MS,
  AUTO_MERGE_CHECK_INTERVAL_MS,
} = require('../config/editorial');
const chunkService = require('./chunk');

const SYSTEM_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000';

async function checkAndAutoMerge() {
  const pool = getPool();

  try {
    // Find proposed chunks older than the low-sensitivity timeout
    // (we check sensitivity per-topic below)
    const minAge = Math.min(MERGE_TIMEOUT_LOW_SENSITIVITY_MS, MERGE_TIMEOUT_HIGH_SENSITIVITY_MS);
    const cutoff = new Date(Date.now() - minAge);

    const { rows: candidates } = await pool.query(
      `SELECT c.id, c.created_at, c.parent_chunk_id,
              t.sensitivity
       FROM chunks c
       JOIN chunk_topics ct ON ct.chunk_id = c.id
       JOIN topics t ON t.id = ct.topic_id
       WHERE c.status = 'proposed' AND c.created_at < $1
       ORDER BY c.created_at ASC`,
      [cutoff]
    );

    let mergedCount = 0;

    for (const candidate of candidates) {
      // Check per-topic timeout
      const timeout = candidate.sensitivity === 'high'
        ? MERGE_TIMEOUT_HIGH_SENSITIVITY_MS
        : MERGE_TIMEOUT_LOW_SENSITIVITY_MS;

      const age = Date.now() - new Date(candidate.created_at).getTime();
      if (age < timeout) continue;

      // Check for down-votes on this proposed chunk
      const { rows: voteRows } = await pool.query(
        `SELECT COUNT(*)::int AS down_count
         FROM votes
         WHERE target_type = 'chunk' AND target_id = $1 AND value = 'down'`,
        [candidate.id]
      );

      if (voteRows[0].down_count > 0) continue; // Community is debating

      // Auto-merge
      try {
        await chunkService.mergeChunk(candidate.id, SYSTEM_ACCOUNT_ID);
        mergedCount++;
      } catch (err) {
        console.error(`Auto-merge failed for chunk ${candidate.id}:`, err.message);
      }
    }

    if (mergedCount > 0) {
      console.log(`Auto-merge: merged ${mergedCount} proposed chunk(s)`);
    }
  } catch (err) {
    console.error('Auto-merge check error:', err.message);
  }
}

let intervalId = null;

function startAutoMerge() {
  if (intervalId) return;
  intervalId = setInterval(checkAndAutoMerge, AUTO_MERGE_CHECK_INTERVAL_MS);
  console.log(`Auto-merge job started (interval: ${AUTO_MERGE_CHECK_INTERVAL_MS}ms)`);
}

function stopAutoMerge() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

module.exports = { checkAndAutoMerge, startAutoMerge, stopAutoMerge };
