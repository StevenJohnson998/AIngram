'use strict';

const { z } = require('zod');
const chunkService = require('../../services/chunk');
const flagService = require('../../services/flag');
const copyrightReviewService = require('../../services/copyright-review');
const { requireAccount, requireBadge, mcpResult, mcpError } = require('../helpers');

const CATEGORY = 'review_moderation';

function registerTools(server, getSessionAccount) {
  const tools = {};

  // ─── CHUNK REVIEW ─────────────────────────────────────────────────

  tools.merge_chunk = server.tool(
    'merge_chunk',
    'Merge a proposed chunk (publish it). Requires policing badge.',
    {
      chunkId: z.string().describe('Proposed chunk UUID'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const result = await chunkService.mergeChunk(params.chunkId, account.id);
        return mcpResult({
          id: result.id,
          status: result.status,
          message: 'Chunk merged (published).',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.reject_chunk = server.tool(
    'reject_chunk',
    'Reject a proposed chunk with reason. Requires policing badge.',
    {
      chunkId: z.string().describe('Proposed chunk UUID'),
      reason: z.string().optional().describe('Rejection reason'),
      category: z.string().optional().describe('Category: inaccurate, unsourced, duplicate, off_topic, low_quality, copyright, other'),
      suggestions: z.string().optional().describe('Improvement suggestions'),
      report: z.boolean().optional().describe('Also create a flag for this chunk'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const result = await chunkService.rejectChunk(params.chunkId, {
          reason: params.reason,
          category: params.category,
          suggestions: params.suggestions,
          report: params.report,
          rejectedBy: account.id,
        });
        return mcpResult({
          id: result.id,
          status: result.status,
          message: 'Chunk rejected.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── FLAGS ────────────────────────────────────────────────────────

  tools.create_flag = server.tool(
    'create_flag',
    'Flag content for review (spam, abuse, etc.). Any active account can flag.',
    {
      targetType: z.enum(['message', 'account', 'chunk', 'topic']).describe('Target type'),
      targetId: z.string().describe('Target UUID'),
      reason: z.string().min(1).describe('Reason for flagging'),
      detectionType: z.enum(['manual', 'temporal_burst', 'network_cluster', 'creator_cluster', 'topic_concentration']).optional().describe('Detection method (default: manual)'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const flag = await flagService.createFlag({
          reporterId: account.id,
          targetType: params.targetType,
          targetId: params.targetId,
          reason: params.reason,
          detectionType: params.detectionType || 'manual',
        });
        return mcpResult({
          id: flag.id,
          targetType: flag.target_type,
          targetId: flag.target_id,
          status: flag.status,
          message: 'Flag created.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.list_flags = server.tool(
    'list_flags',
    'List content flags. Requires policing badge.',
    {
      status: z.enum(['open', 'reviewing', 'dismissed', 'actioned']).optional().describe('Filter by status (default: open)'),
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const result = await flagService.listFlags({
          status: params.status || 'open',
          page: params.page || 1,
          limit: Math.min(params.limit || 20, 100),
        });
        return mcpResult({
          flags: result.data.map(f => ({
            id: f.id,
            reporterId: f.reporter_id,
            targetType: f.target_type,
            targetId: f.target_id,
            reason: f.reason,
            status: f.status,
            detectionType: f.detection_type,
            createdAt: f.created_at,
          })),
          pagination: result.pagination,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.review_flag = server.tool(
    'review_flag',
    'Mark a flag as "reviewing". Requires policing badge.',
    {
      flagId: z.string().describe('Flag UUID'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const result = await flagService.reviewFlag(params.flagId, account.id);
        return mcpResult({
          id: result.id,
          status: result.status,
          message: 'Flag marked as reviewing.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.dismiss_flag = server.tool(
    'dismiss_flag',
    'Dismiss a flag (no action needed). Requires policing badge.',
    {
      flagId: z.string().describe('Flag UUID'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const result = await flagService.dismissFlag(params.flagId, account.id);
        return mcpResult({
          id: result.id,
          status: result.status,
          message: 'Flag dismissed.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.action_flag = server.tool(
    'action_flag',
    'Take action on a flag. Requires policing badge.',
    {
      flagId: z.string().describe('Flag UUID'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const result = await flagService.actionFlag(params.flagId, account.id);
        return mcpResult({
          id: result.id,
          status: result.status,
          message: 'Flag actioned.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_flags_by_target = server.tool(
    'get_flags_by_target',
    'Get all flags on a specific target. Requires policing badge.',
    {
      targetType: z.enum(['message', 'chunk', 'account']).describe('Target type'),
      targetId: z.string().describe('Target UUID'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const result = await flagService.getFlagsByTarget(params.targetType, params.targetId);
        return mcpResult({
          flags: (result.data || result).map(f => ({
            id: f.id,
            reporterId: f.reporter_id,
            reason: f.reason,
            status: f.status,
            detectionType: f.detection_type,
            createdAt: f.created_at,
          })),
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── COPYRIGHT REVIEWS ────────────────────────────────────────────

  tools.create_copyright_review = server.tool(
    'create_copyright_review',
    'Flag a chunk for copyright review. Requires active account.',
    {
      chunkId: z.string().describe('Chunk UUID'),
      reason: z.string().min(10).describe('Copyright concern (min 10 chars)'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const result = await copyrightReviewService.createCopyrightReview({
          chunkId: params.chunkId,
          flaggedBy: account.id,
          reason: params.reason,
        });
        return mcpResult({
          id: result.id,
          chunkId: result.chunk_id,
          status: result.status,
          priority: result.priority,
          message: 'Copyright review created.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.list_copyright_reviews = server.tool(
    'list_copyright_reviews',
    'List copyright review queue. Requires policing badge.',
    {
      status: z.enum(['pending', 'assigned', 'resolved']).optional().describe('Filter by status (default: pending)'),
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
    },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const result = await copyrightReviewService.listCopyrightReviews({
          status: params.status || 'pending',
          page: params.page || 1,
          limit: Math.min(params.limit || 20, 100),
        });
        return mcpResult({
          reviews: result.data.map(r => ({
            id: r.id,
            chunkId: r.chunk_id,
            flaggedBy: r.flagged_by,
            reason: r.reason,
            status: r.status,
            priority: r.priority,
            createdAt: r.created_at,
          })),
          pagination: result.pagination,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  return tools;
}

module.exports = { CATEGORY, registerTools };
