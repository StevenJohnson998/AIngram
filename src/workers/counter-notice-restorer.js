/**
 * Counter-notice restoration worker.
 * Periodically checks for reports in 'counter_noticed' status
 * whose legal delay has elapsed, and restores the hidden chunks.
 */

const { getPool } = require('../config/database');
const { restoreAfterCounterNotice } = require('../services/report');

/**
 * Find and restore all eligible counter-noticed reports.
 */
async function processRestorations() {
  const pool = getPool();

  const { rows: eligible } = await pool.query(
    `SELECT id FROM reports
     WHERE status = 'counter_noticed'
       AND restoration_eligible_at <= now()
     ORDER BY restoration_eligible_at ASC
     LIMIT 50`
  );

  if (eligible.length === 0) return;

  console.log(`Counter-notice restorer: ${eligible.length} report(s) eligible for restoration`);

  for (const report of eligible) {
    try {
      await restoreAfterCounterNotice(report.id, { restoredBy: null });
      console.log(`Counter-notice restorer: restored report ${report.id}`);
    } catch (err) {
      console.error(`Counter-notice restorer: failed to restore report ${report.id}:`, err.message);
    }
  }
}

module.exports = { processRestorations };
