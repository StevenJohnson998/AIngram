'use strict';

const { z } = require('zod');
const changesetService = require('../../services/changeset');
const flagService = require('../../services/flag');
const copyrightReviewService = require('../../services/copyright-review');
const { requireAccount, requireTier, requireBadge, mcpResult, mcpError } = require('../helpers');

const CATEGORY = 'review_moderation';

function registerTools(server, getSessionAccount) {
  const tools = {};

  // ─── CHANGESET REVIEW ──────────────────────────────────────────────

  tools.merge_changeset = server.tool(
    'merge_changeset',
    'Merge a changeset (atomically publish all its operations). Policing badge can merge anything. Contribution badge + tier 1 can merge standard-sensitivity topics only (must set confirmSensitivity to "standard"). Skill: reviewing-content',
    {
      changesetId: z.string().describe('Changeset UUID'),
      confirmSensitivity: z.enum(['standard']).optional().describe('Required for contribution-badge merges: confirm the topic is standard sensitivity'),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        requireTier(account, 1);
        const hasPolicing = account.badgePolicing;
        const hasContribution = account.badgeContribution;

        if (!hasPolicing && !hasContribution) {
          throw Object.assign(new Error('Requires contribution or policing badge to merge'), { code: 'FORBIDDEN' });
        }

        if (!hasPolicing) {
          if (params.confirmSensitivity !== 'standard') {
            throw Object.assign(new Error('Contribution badge holders must pass confirmSensitivity: "standard" to merge. Sensitive topics require policing badge.'), { code: 'FORBIDDEN' });
          }
          const changeset = await changesetService.getChangesetById(params.changesetId);
          if (!changeset) throw Object.assign(new Error('Changeset not found'), { code: 'NOT_FOUND' });

          const { getPool } = require('../../config/database');
          const { rows } = await getPool().query('SELECT sensitivity FROM topics WHERE id = $1', [changeset.topic_id]);
          if (rows.length === 0) throw Object.assign(new Error('Topic not found'), { code: 'NOT_FOUND' });
          if (rows[0].sensitivity !== 'standard') {
            throw Object.assign(new Error('This topic is marked as sensitive. Only policing badge holders can merge sensitive changesets.'), { code: 'FORBIDDEN' });
          }
        }

        const result = await changesetService.mergeChangeset(params.changesetId, account.id);
        return mcpResult({
          changesetId: result.id,
          status: result.status,
          message: 'Changeset merged (published).',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.reject_changeset = server.tool(
    'reject_changeset',
    'Reject a changeset with reason. All operations are retracted atomically. Requires policing badge. Skill: reviewing-content',
    {
      changesetId: z.string().describe('Changeset UUID'),
      reason: z.string().optional().describe('Rejection reason'),
      category: z.string().optional().describe('Category: inaccurate, unsourced, duplicate, off_topic, low_quality, copyright, other'),
      suggestions: z.string().optional().describe('Improvement suggestions'),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        requireTier(account, 1);
        requireBadge(account, 'policing');
        const result = await changesetService.rejectChangeset(params.changesetId, {
          reason: params.reason,
          category: params.category,
          suggestions: params.suggestions,
          rejectedBy: account.id,
        });
        return mcpResult({
          changesetId: result.id,
          status: result.status,
          message: 'Changeset rejected.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── FLAGS ────────────────────────────────────────────────────────

  tools.create_flag = server.tool(
    'create_flag',
    'Flag content for review (spam, abuse, etc.). Any active account can flag. Skills: moderation-triage, spotting-abuse',
    {
      targetType: z.enum(['message', 'account', 'chunk', 'topic']).describe('Target type'),
      targetId: z.string().describe('Target UUID'),
      reason: z.string().min(1).describe('Reason for flagging'),
      detectionType: z.enum(['manual', 'temporal_burst', 'network_cluster', 'creator_cluster', 'topic_concentration']).optional().describe('Detection method (default: manual)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
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
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
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

  tools.resolve_flag = server.tool(
    'resolve_flag',
    'Resolve a flag: "review" (mark as reviewing), "dismiss" (no action needed), or "action" (escalate). Requires policing badge. Skill: moderation-triage',
    {
      flagId: z.string().describe('Flag UUID'),
      action: z.enum(['review', 'dismiss', 'action']).describe('"review" to claim, "dismiss" to close as noise, "action" to escalate'),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const handlers = {
          review: () => flagService.reviewFlag(params.flagId, account.id),
          dismiss: () => flagService.dismissFlag(params.flagId, account.id),
          action: () => flagService.actionFlag(params.flagId, account.id),
        };
        const result = await handlers[params.action]();
        const labels = { review: 'Flag marked as reviewing.', dismiss: 'Flag dismissed.', action: 'Flag actioned.' };
        return mcpResult({ id: result.id, status: result.status, message: labels[params.action] });
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
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
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
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
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
