'use strict';

const { z } = require('zod');
const copyrightAnalytics = require('../../services/copyright-analytics');
const { getPool } = require('../../config/database');
const { requireAccount, requireBadge, mcpResult, mcpError } = require('../helpers');

const CATEGORY = 'analytics';

function registerTools(server, getSessionAccount) {
  const tools = {};

  // ─── PUBLIC ANALYTICS ─────────────────────────────────────────────

  tools.hot_topics = server.tool(
    'hot_topics',
    'Get trending topics by recent activity.',
    {
      days: z.number().optional().describe('Time window in days (default 7, max 90)'),
      limit: z.number().optional().describe('Max results (default 10, max 50)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      try {
        const days = Math.min(params.days || 7, 90);
        const limit = Math.min(params.limit || 10, 50);
        const pool = getPool();
        const { rows } = await pool.query(
          `SELECT t.id, t.title, t.slug, COUNT(al.id)::int AS activity_count,
                  MAX(al.created_at) AS last_activity
           FROM activity_log al
           JOIN chunk_topics ct ON ct.chunk_id = al.target_id AND al.target_type = 'chunk'
           JOIN topics t ON t.id = ct.topic_id
           WHERE al.created_at > NOW() - make_interval(days => $1)
           GROUP BY t.id, t.title, t.slug
           ORDER BY activity_count DESC, last_activity DESC
           LIMIT $2`,
          [days, limit]
        );
        return mcpResult({
          topics: rows.map(r => ({
            id: r.id,
            title: r.title,
            slug: r.slug,
            activityCount: r.activity_count,
            lastActivity: r.last_activity,
          })),
          periodDays: days,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.activity_feed = server.tool(
    'activity_feed',
    'Get the public activity feed (recent actions across the platform).',
    {
      limit: z.number().optional().describe('Max entries (default 20, max 50)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      try {
        const limit = Math.min(params.limit || 20, 50);
        const pool = getPool();
        const { rows } = await pool.query(
          `SELECT al.id, al.action, al.target_type, al.target_id, al.metadata, al.created_at,
                  a.name AS actor_name,
                  t.title AS target_title, t.slug AS topic_slug
           FROM activity_log al
           LEFT JOIN accounts a ON a.id = al.actor_id
           LEFT JOIN chunk_topics ct ON ct.chunk_id = al.target_id AND al.target_type = 'chunk'
           LEFT JOIN topics t ON t.id = ct.topic_id
           ORDER BY al.created_at DESC
           LIMIT $1`,
          [limit]
        );
        return mcpResult({
          activities: rows.map(r => ({
            id: r.id,
            action: r.action,
            actorName: r.actor_name,
            targetType: r.target_type,
            targetId: r.target_id,
            targetTitle: r.target_title,
            topicSlug: r.topic_slug,
            metadata: r.metadata,
            createdAt: r.created_at,
          })),
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── COPYRIGHT ANALYTICS (policing badge) ─────────────────────────

  tools.copyright_overview = server.tool(
    'copyright_overview',
    'Get copyright review statistics overview. Requires policing badge.',
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (_params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const overview = await copyrightAnalytics.getOverview();
        return mcpResult(overview);
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.copyright_reporters = server.tool(
    'copyright_reporters',
    'Get per-reporter copyright statistics. Requires policing badge.',
    {
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
      sortBy: z.enum(['total_reports', 'fp_rate', 'takedowns', 'last_report_at']).optional().describe('Sort field (default: total_reports)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const result = await copyrightAnalytics.getReporterStats({
          page: params.page || 1,
          limit: Math.min(params.limit || 20, 100),
          sortBy: params.sortBy || 'total_reports',
        });
        return mcpResult(result);
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.copyright_timeline = server.tool(
    'copyright_timeline',
    'Get daily copyright verdict counts over time. Requires policing badge.',
    {
      days: z.number().optional().describe('Time window in days (default 30, max 365)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const timeline = await copyrightAnalytics.getVerdictTimeline({
          days: Math.min(params.days || 30, 365),
        });
        return mcpResult({ timeline });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  return tools;
}

module.exports = { CATEGORY, registerTools };
