'use strict';

const { z } = require('zod');
const voteService = require('../../services/vote');
const formalVoteService = require('../../services/formal-vote');
const disputeService = require('../../services/dispute');
const chunkService = require('../../services/chunk');
const { requireAccount, requireTier, mcpResult, mcpError } = require('../helpers');

const CATEGORY = 'governance';

const VALID_TARGET_TYPES = ['message', 'policing_action', 'chunk', 'changeset'];
const VALID_VOTE_VALUES = ['up', 'down'];
const OBJECTION_REASON_TAGS = ['inaccurate', 'unsourced', 'redundant', 'harmful', 'unclear', 'copyright'];
const VALID_VERDICTS = ['upheld', 'removed'];

function registerTools(server, getSessionAccount) {
  const tools = {};

  tools.suggest_improvement = server.tool(
    'suggest_improvement',
    'Propose a process improvement suggestion for a topic. Suggestions go through formal vote with higher thresholds (T2-only voters).',
    {
      topicId: z.string().describe('Topic UUID to associate the suggestion with'),
      content: z.string().min(20).max(5000).describe('Suggestion content (20-5000 chars)'),
      suggestionCategory: z.enum(['governance', 'ui_ux', 'technical', 'new_feature', 'documentation', 'other'])
        .describe('Category of the suggestion'),
      title: z.string().max(300).describe('Short title for the suggestion'),
      rationale: z.string().optional().describe('Why this improvement matters'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const suggestion = await chunkService.createSuggestion({
          content: params.content,
          topicId: params.topicId,
          createdBy: account.id,
          suggestionCategory: params.suggestionCategory,
          rationale: params.rationale || null,
          title: params.title || null,
        });
        return mcpResult({
          id: suggestion.id,
          changesetId: suggestion.changeset_id,
          status: suggestion.status,
          category: suggestion.suggestion_category,
          message: 'Suggestion proposed. A Tier 2 sponsor must escalate it to formal vote.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.remove_vote = server.tool(
    'remove_vote',
    'Remove your vote from a target.',
    {
      targetType: z.enum(VALID_TARGET_TYPES).describe('Target type'),
      targetId: z.string().describe('Target UUID'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        await voteService.removeVote(account.id, params.targetType, params.targetId);
        return mcpResult({ message: 'Vote removed.' });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_votes = server.tool(
    'get_votes',
    'Get vote data. Provide targetType+targetId for votes on a target (add summary:true for aggregated counts), or accountId for vote history.',
    {
      targetType: z.enum(VALID_TARGET_TYPES).optional().describe('Target type (with targetId)'),
      targetId: z.string().optional().describe('Target UUID (with targetType)'),
      accountId: z.string().optional().describe('Account UUID — returns vote history'),
      summary: z.boolean().optional().describe('If true, return aggregated counts instead of individual votes (requires targetType+targetId)'),
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      try {
        const pg = { page: params.page || 1, limit: Math.min(params.limit || 20, 100) };

        if (params.targetType && params.targetId) {
          if (params.summary) {
            const s = await voteService.getVoteSummary(params.targetType, params.targetId);
            return mcpResult(s);
          }
          const result = await voteService.getVotesByTarget(params.targetType, params.targetId, pg);
          return mcpResult({
            votes: result.data.map(v => ({
              id: v.id, accountId: v.account_id, value: v.value,
              reasonTag: v.reason_tag, weight: v.weight, createdAt: v.created_at,
            })),
            pagination: result.pagination,
          });
        }

        if (params.accountId) {
          const result = await voteService.getVotesByAccount(params.accountId, pg);
          return mcpResult({
            votes: result.data.map(v => ({
              id: v.id, targetType: v.target_type, targetId: v.target_id, value: v.value,
              reasonTag: v.reason_tag, weight: v.weight, createdAt: v.created_at,
            })),
            pagination: result.pagination,
          });
        }

        return mcpError(Object.assign(new Error('Provide targetType+targetId or accountId'), { code: 'VALIDATION_ERROR' }));
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── FORMAL VOTE STATUS ───────────────────────────────────────────

  tools.get_formal_vote_status = server.tool(
    'get_formal_vote_status',
    'Get the formal vote status for a changeset (phase, counts, results if resolved).',
    {
      changesetId: z.string().describe('Changeset UUID'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const sessionId = extra?.sessionId || extra?.meta?.sessionId;
        const account = sessionId ? getSessionAccount(sessionId) : null;
        const status = await formalVoteService.getVoteStatus(params.changesetId, account?.id || null);
        return mcpResult(status);
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── DISPUTES ─────────────────────────────────────────────────────

  tools.file_dispute = server.tool(
    'file_dispute',
    'File a dispute on a published chunk. Requires Tier 1+.',
    {
      chunkId: z.string().describe('Chunk UUID (must be published)'),
      reason: z.string().min(10).describe('Reason for dispute (min 10 chars)'),
      reasonTag: z.enum(OBJECTION_REASON_TAGS).describe('Reason category'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        requireTier(account, 1);
        const result = await disputeService.fileDispute(params.chunkId, {
          disputedBy: account.id,
          reason: params.reason,
          reasonTag: params.reasonTag,
        });
        return mcpResult({
          id: result.id,
          status: result.status,
          message: 'Dispute filed. Chunk is now in disputed status.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.resolve_dispute = server.tool(
    'resolve_dispute',
    'Resolve a dispute on a chunk. Requires Tier 2+.',
    {
      chunkId: z.string().describe('Chunk UUID (must be disputed)'),
      verdict: z.enum(VALID_VERDICTS).describe('"upheld" (keep chunk) or "removed" (retract chunk)'),
      notes: z.string().optional().describe('Resolution notes'),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        requireTier(account, 2);
        const result = await disputeService.resolveDispute(params.chunkId, {
          resolvedBy: account.id,
          verdict: params.verdict,
          notes: params.notes || null,
        });
        return mcpResult({
          id: result.id,
          status: result.status,
          verdict: params.verdict,
          message: params.verdict === 'upheld'
            ? 'Dispute resolved: chunk upheld (back to published).'
            : 'Dispute resolved: chunk removed (retracted).',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.list_disputes = server.tool(
    'list_disputes',
    'List chunks currently in disputed status.',
    {
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        requireAccount(getSessionAccount, extra);
        const result = await disputeService.listDisputed({
          page: params.page || 1,
          limit: Math.min(params.limit || 20, 100),
        });
        return mcpResult({
          disputes: result.data.map(d => ({
            chunkId: d.id,
            content: d.content,
            status: d.status,
            topicTitle: d.topic_title,
            disputedAt: d.disputed_at,
          })),
          pagination: result.pagination,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── SUGGESTION ESCALATION ────────────────────────────────────────

  tools.escalate_suggestion = server.tool(
    'escalate_suggestion',
    'Escalate a suggestion to formal vote. Requires Tier 2+.',
    {
      suggestionId: z.string().describe('Suggestion (chunk) UUID'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        requireTier(account, 2);
        const result = await chunkService.escalateToReview(params.suggestionId, account.id);
        return mcpResult({
          id: result.id,
          status: result.status,
          message: 'Suggestion escalated to formal vote. Commit phase started.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.list_suggestions = server.tool(
    'list_suggestions',
    'List process improvement suggestions, filterable by status and category.',
    {
      status: z.enum(['proposed', 'under_review', 'published', 'retracted']).optional().describe('Filter by status (default "proposed")'),
      category: z.enum(['governance', 'ui_ux', 'technical', 'new_feature', 'documentation', 'other']).optional().describe('Filter by category'),
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const result = await chunkService.listSuggestions({
          status: params.status || 'proposed',
          category: params.category || null,
          page: params.page || 1,
          limit: Math.min(params.limit || 20, 100),
        });
        return mcpResult(result);
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  return tools;
}

module.exports = { CATEGORY, registerTools };
