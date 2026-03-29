-- Migration 032: Copyright analytics materialized views
-- Sprint 7: Aggregated metrics from copyright_reviews, refreshed by worker.

-- System-wide copyright review aggregate (single row)
CREATE MATERIALIZED VIEW IF NOT EXISTS copyright_analytics AS
SELECT
  COUNT(*)::int AS total_reviews,
  COUNT(*) FILTER (WHERE verdict = 'clear')::int AS clear_count,
  COUNT(*) FILTER (WHERE verdict = 'rewrite_required')::int AS rewrite_count,
  COUNT(*) FILTER (WHERE verdict = 'takedown')::int AS takedown_count,
  ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600)::numeric, 1) AS avg_resolution_hours,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600)::numeric, 1) AS median_resolution_hours,
  CASE WHEN COUNT(*) > 0
    THEN ROUND((COUNT(*) FILTER (WHERE verdict = 'clear')::float / COUNT(*))::numeric, 3)
    ELSE 0 END AS system_fp_rate,
  COUNT(*) FILTER (WHERE priority = 'high')::int AS high_priority_count,
  now() AS refreshed_at
FROM copyright_reviews
WHERE status = 'resolved';

-- Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_copyright_analytics_singleton ON copyright_analytics (refreshed_at);

-- Per-reporter copyright stats
CREATE MATERIALIZED VIEW IF NOT EXISTS copyright_reporter_stats AS
SELECT
  flagged_by AS reporter_id,
  COUNT(*)::int AS total_reports,
  COUNT(*) FILTER (WHERE verdict = 'clear')::int AS false_positives,
  COUNT(*) FILTER (WHERE verdict = 'takedown')::int AS takedowns,
  COUNT(*) FILTER (WHERE verdict = 'rewrite_required')::int AS rewrites,
  CASE WHEN COUNT(*) > 0
    THEN ROUND((COUNT(*) FILTER (WHERE verdict = 'clear')::float / COUNT(*))::numeric, 3)
    ELSE 0 END AS fp_rate,
  MAX(created_at) AS last_report_at
FROM copyright_reviews
WHERE status = 'resolved' AND flagged_by IS NOT NULL
GROUP BY flagged_by;

CREATE UNIQUE INDEX IF NOT EXISTS idx_copyright_reporter_stats_id ON copyright_reporter_stats (reporter_id);

COMMENT ON MATERIALIZED VIEW copyright_analytics IS 'Sprint 7: aggregated copyright review metrics, refreshed by worker every 6h';
COMMENT ON MATERIALIZED VIEW copyright_reporter_stats IS 'Sprint 7: per-reporter copyright review stats, refreshed by worker every 6h';
