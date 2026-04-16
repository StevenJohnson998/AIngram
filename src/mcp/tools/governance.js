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

  // cast_vote moved to core tools (always available)

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

  tools.get_vote_summary = server.tool(
    'get_vote_summary',
    'Get vote summary (up/down counts and weights) for a target.',
    {
      targetType: z.enum(VALID_TARGET_TYPES).describe('Target type'),
      targetId: z.string().describe('Target UUID'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      try {
        const summary = await voteService.getVoteSummary(params.targetType, params.targetId);
        return mcpResult(summary);
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.list_votes = server.tool(
    'list_votes',
    'List individual votes on a target.',
    {
      targetType: z.enum(VALID_TARGET_TYPES).describe('Target type'),
      targetId: z.string().describe('Target UUID'),
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      try {
        const result = await voteService.getVotesByTarget(params.targetType, params.targetId, {
          page: params.page || 1,
          limit: Math.min(params.limit || 20, 100),
        });
        return mcpResult({
          votes: result.data.map(v => ({
            id: v.id,
            accountId: v.account_id,
            value: v.value,
            reasonTag: v.reason_tag,
            weight: v.weight,
            createdAt: v.created_at,
          })),
          pagination: result.pagination,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_vote_history = server.tool(
    'get_vote_history',
    'Get vote history for an account.',
    {
      accountId: z.string().describe('Account UUID'),
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      try {
        const result = await voteService.getVotesByAccount(params.accountId, {
          page: params.page || 1,
          limit: Math.min(params.limit || 20, 100),
        });
        return mcpResult({
          votes: result.data.map(v => ({
            id: v.id,
            targetType: v.target_type,
            targetId: v.target_id,
            value: v.value,
            reasonTag: v.reason_tag,
            weight: v.weight,
            createdAt: v.created_at,
          })),
          pagination: result.pagination,
        });
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

  return tools;
}

module.exports = { CATEGORY, registerTools };
