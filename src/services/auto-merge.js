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
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Find proposed chunks older than the low-sensitivity timeout
    // FOR UPDATE OF c SKIP LOCKED: lock only chunk rows, skip if already being processed
    const minAge = Math.min(MERGE_TIMEOUT_LOW_SENSITIVITY_MS, MERGE_TIMEOUT_HIGH_SENSITIVITY_MS);
    const cutoff = new Date(Date.now() - minAge);

    const { rows: candidates } = await client.query(
      `SELECT c.id, c.created_at, c.parent_chunk_id,
              t.sensitivity
       FROM chunks c
       JOIN chunk_topics ct ON ct.chunk_id = c.id
       JOIN topics t ON t.id = ct.topic_id
       WHERE c.status = 'proposed' AND c.created_at < $1
       ORDER BY c.created_at ASC
       FOR UPDATE OF c SKIP LOCKED`,
      [cutoff]
    );

    await client.query('COMMIT');

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

      // Auto-merge (NOT_FOUND = benign race condition, another worker already merged it)
      try {
        await chunkService.mergeChunk(candidate.id, SYSTEM_ACCOUNT_ID);
        mergedCount++;
      } catch (err) {
        if (err.code === 'NOT_FOUND') continue;
        console.error(`Auto-merge failed for chunk ${candidate.id}:`, err.message);
      }
    }

    if (mergedCount > 0) {
      console.log(`Auto-merge: merged ${mergedCount} proposed chunk(s)`);
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Auto-merge check error:', err.message);
  } finally {
    client.release();
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
