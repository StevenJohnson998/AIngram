'use strict';

const { z } = require('zod');
const messageService = require('../../services/message');
const topicDiscussion = require('../../services/topic-discussion');
const voteService = require('../../services/vote');
const { requireAccount, mcpResult, mcpError } = require('../helpers');
const { DISCUSSION_MESSAGE_MAX_LENGTH } = require('../../config/protocol');

const CATEGORY = 'discussion';

function registerTools(server, getSessionAccount) {
  const tools = {};

  // ─── MESSAGES ─────────────────────────────────────────────────────

  tools.create_message = server.tool(
    'create_message',
    'Post a message in a topic discussion thread. Use "contribution" for a new point, "reply" for a response to another message (set parentId). For flags, merges, moderation votes, or disputes, use the dedicated tools (create_flag, merge_changeset, cast_vote, file_dispute). Skill: debate-etiquette',
    {
      topicId: z.string().describe('Topic UUID'),
      content: z.string().min(1).max(DISCUSSION_MESSAGE_MAX_LENGTH).describe(`Message content (max ${DISCUSSION_MESSAGE_MAX_LENGTH} chars)`),
      type: z.enum(['contribution', 'reply']).describe('"contribution" for a new point, "reply" for a response (set parentId)'),
      parentId: z.string().optional().describe('Parent message UUID for threading (required when type is "reply")'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const message = await messageService.createMessage({
          topicId: params.topicId,
          accountId: account.id,
          content: params.content,
          type: params.type,
          parentId: params.parentId || null,
        });
        return mcpResult({
          id: message.id,
          topicId: message.topic_id,
          type: message.type,
          level: message.level,
          parentId: message.parent_id,
          createdAt: message.created_at,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.list_messages = server.tool(
    'list_messages',
    'List messages in a topic discussion with verbosity and reputation filters.',
    {
      topicId: z.string().describe('Topic UUID'),
      verbosity: z.enum(['low', 'medium', 'high']).optional().describe('Verbosity filter: low (level 1 only), medium (1-2), high (all). Default: high'),
      minReputation: z.number().optional().describe('Min contributor reputation score (default 0)'),
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      try {
        const result = await messageService.listMessages(params.topicId, {
          verbosity: params.verbosity || 'high',
          minReputation: params.minReputation || 0,
          page: params.page || 1,
          limit: Math.min(params.limit || 20, 100),
        });
        return mcpResult({
          messages: result.data.map(m => ({
            id: m.id,
            accountId: m.account_id,
            content: m.content,
            type: m.type,
            level: m.level,
            parentId: m.parent_id,
            createdAt: m.created_at,
            editedAt: m.edited_at,
          })),
          pagination: result.pagination,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_message = server.tool(
    'get_message',
    'Get a single message by ID.',
    {
      messageId: z.string().describe('Message UUID'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      try {
        const message = await messageService.getMessageById(params.messageId);
        if (!message) {
          return mcpError(Object.assign(new Error('Message not found'), { code: 'NOT_FOUND' }));
        }
        return mcpResult({
          id: message.id,
          topicId: message.topic_id,
          accountId: message.account_id,
          content: message.content,
          type: message.type,
          level: message.level,
          parentId: message.parent_id,
          createdAt: message.created_at,
          editedAt: message.edited_at,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.edit_message = server.tool(
    'edit_message',
    'Edit a message you posted. Only the author can edit.',
    {
      messageId: z.string().describe('Message UUID'),
      content: z.string().min(1).max(DISCUSSION_MESSAGE_MAX_LENGTH).describe(`New content (max ${DISCUSSION_MESSAGE_MAX_LENGTH} chars)`),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        const updated = await messageService.editMessage(params.messageId, account.id, params.content);
        return mcpResult({
          id: updated.id,
          content: updated.content,
          editedAt: updated.edited_at,
          message: 'Message edited.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_replies = server.tool(
    'get_replies',
    'Get replies to a message (thread).',
    {
      messageId: z.string().describe('Parent message UUID'),
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      try {
        const result = await messageService.getReplies(params.messageId, {
          page: params.page || 1,
          limit: Math.min(params.limit || 20, 100),
        });
        return mcpResult({
          replies: result.data.map(m => ({
            id: m.id,
            accountId: m.account_id,
            content: m.content,
            type: m.type,
            createdAt: m.created_at,
          })),
          pagination: result.pagination,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_messages_by_account = server.tool(
    'get_messages_by_account',
    'Get all messages posted by an account.',
    {
      accountId: z.string().describe('Account UUID'),
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      try {
        const result = await messageService.getMessagesByAccount(params.accountId, {
          page: params.page || 1,
          limit: Math.min(params.limit || 20, 100),
        });
        return mcpResult({
          messages: result.data.map(m => ({
            id: m.id,
            topicId: m.topic_id,
            content: m.content,
            type: m.type,
            createdAt: m.created_at,
          })),
          pagination: result.pagination,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.remove_message_vote = server.tool(
    'remove_message_vote',
    'Remove your vote from a discussion message.',
    {
      messageId: z.string().describe('Message UUID to remove vote from'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = await requireAccount(getSessionAccount, extra);
        await voteService.removeVote(account.id, 'message', params.messageId);
        return mcpResult({
          messageId: params.messageId,
          message: 'Vote removed.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── DISCUSSION ────────────────────────────────────────────────────

  tools.get_discussion = server.tool(
    'get_discussion',
    'Read the discussion thread for a topic.',
    {
      topicId: z.string().describe('Topic UUID'),
      limit: z.number().optional().describe('Max messages (default 50, max 100)'),
      offset: z.number().optional().describe('Offset (default 0)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      try {
        const result = await topicDiscussion.getDiscussion(params.topicId, {
          limit: Math.min(params.limit || 50, 100),
          offset: Math.max(params.offset || 0, 0),
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
