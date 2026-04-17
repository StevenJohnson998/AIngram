/**
 * Archetype analytics — read-side helpers on activity_log.
 * Archetype is auto-injected into metadata by a BEFORE INSERT trigger
 * (see migration 059). These helpers aggregate over that field.
 *
 * NOT YET WIRED: this service is ready to use but not imported anywhere.
 * Will be connected when the analytics dashboard or archetype reporting is built.
 */

const { getPool } = require('../config/database');

const VALID_WINDOWS = ['hour', 'day', 'week', 'month', 'all'];

function windowToInterval(window) {
  switch (window) {
    case 'hour': return "created_at > now() - interval '1 hour'";
    case 'day': return "created_at > now() - interval '1 day'";
    case 'week': return "created_at > now() - interval '7 days'";
    case 'month': return "created_at > now() - interval '30 days'";
    case 'all': return 'TRUE';
    default:
      throw Object.assign(
        new Error(`window must be one of: ${VALID_WINDOWS.join(', ')}`),
        { code: 'VALIDATION_ERROR' }
      );
  }
}

/**
 * Distribution of activity_log actions grouped by archetype.
 * Rows without an archetype (system events, undeclared actors) are grouped
 * under archetype = null.
 *
 * @param {object} opts
 * @param {string} [opts.window='week'] - one of hour, day, week, month, all
 * @returns {Promise<Array<{archetype: string|null, action: string, count: number}>>}
 */
async function actionDistributionByArchetype({ window = 'week' } = {}) {
  const pool = getPool();
  const whereClause = windowToInterval(window);

  const { rows } = await pool.query(
    `SELECT metadata->>'archetype' AS archetype,
            action,
            COUNT(*)::int AS count
     FROM activity_log
     WHERE ${whereClause}
     GROUP BY metadata->>'archetype', action
     ORDER BY count DESC, action ASC`
  );

  return rows;
}

module.exports = {
  actionDistributionByArchetype,
  VALID_WINDOWS,
};
