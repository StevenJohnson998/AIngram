/**
 * Copyright analytics service — reads from materialized views.
 * Views are refreshed by the worker every T_ANALYTICS_REFRESH_MS.
 */

const { getPool } = require('../config/database');

/**
 * Get system-wide copyright review overview (single-row aggregate).
 */
async function getOverview() {
  const pool = getPool();
  const { rows } = await pool.query('SELECT * FROM copyright_analytics');
  return rows[0] || {
    total_reviews: 0,
    clear_count: 0,
    rewrite_count: 0,
    takedown_count: 0,
    avg_resolution_hours: null,
    median_resolution_hours: null,
    system_fp_rate: 0,
    high_priority_count: 0,
    refreshed_at: null,
  };
}

/**
 * Get per-reporter copyright stats (paginated).
 */
async function getReporterStats({ page = 1, limit = 20, sortBy = 'total_reports' } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const validSorts = ['total_reports', 'fp_rate', 'takedowns', 'last_report_at'];
  const orderCol = validSorts.includes(sortBy) ? sortBy : 'total_reports';

  const [countResult, dataResult] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS total FROM copyright_reporter_stats'),
    pool.query(
      `SELECT crs.*, a.name AS reporter_name
       FROM copyright_reporter_stats crs
       LEFT JOIN accounts a ON a.id = crs.reporter_id
       ORDER BY ${orderCol} DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
  ]);

  return {
    data: dataResult.rows,
    pagination: { page, limit, total: countResult.rows[0].total },
  };
}

/**
 * Get verdict timeline — daily verdict counts for the last N days.
 */
async function getVerdictTimeline({ days = 30 } = {}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT
       DATE(resolved_at) AS day,
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE verdict = 'clear')::int AS clear_count,
       COUNT(*) FILTER (WHERE verdict = 'rewrite_required')::int AS rewrite_count,
       COUNT(*) FILTER (WHERE verdict = 'takedown')::int AS takedown_count
     FROM copyright_reviews
     WHERE status = 'resolved' AND resolved_at >= now() - ($1 || ' days')::interval
     GROUP BY DATE(resolved_at)
     ORDER BY day ASC`,
    [days]
  );
  return rows;
}

/**
 * Refresh both materialized views (non-blocking CONCURRENTLY).
 * Called by the worker on interval.
 */
async function refreshViews() {
  const pool = getPool();
  try {
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY copyright_analytics');
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY copyright_reporter_stats');
    console.log('Copyright analytics views refreshed');
  } catch (err) {
    console.error('Analytics view refresh failed:', err.message);
  }
}

module.exports = {
  getOverview,
  getReporterStats,
  getVerdictTimeline,
  refreshViews,
};
