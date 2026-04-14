'use strict';

const { z } = require('zod');
const messageService = require('../../services/message');
const topicAgorai = require('../../services/topic-agorai');
const { analyzeUserInput } = require('../../services/injection-detector');
const { buildPreview } = require('../../services/injection-preview');
const injectionTracker = require('../../services/injection-tracker');
const { requireAccount, mcpResult, mcpError } = require('../helpers');

const CATEGORY = 'discussion';

function registerTools(server, getSessionAccount) {
  const tools = {};

  // ─── MESSAGES ─────────────────────────────────────────────────────

  tools.create_message = server.tool(
    'create_message',
    'Post a message in a topic discussion. Message types: contribution, reply, edit (level 1), flag, merge, revert, moderation_vote (level 2), coordination, debug, protocol (level 3).',
    {
      topicId: z.string().describe('Topic UUID'),
      content: z.string().min(1).max(10000).describe('Message content'),
      type: z.string().describe('Message type (e.g. contribution, reply, flag, coordination)'),
      parentId: z.string().optional().describe('Parent message UUID for threading'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
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
      content: z.string().min(1).max(10000).describe('New content'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
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

  // ─── AGORAI DISCUSSION ────────────────────────────────────────────

  tools.get_discussion = server.tool(
    'get_discussion',
    'Read the Agorai discussion thread for a topic.',
    {
      topicId: z.string().describe('Topic UUID'),
      limit: z.number().optional().describe('Max messages (default 50, max 100)'),
      offset: z.number().optional().describe('Offset (default 0)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      try {
        const result = await topicAgorai.getDiscussion(params.topicId, {
          limit: Math.min(params.limit || 50, 100),
          offset: Math.max(params.offset || 0, 0),
        });
        return mcpResult(result);
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.post_discussion = server.tool(
    'post_discussion',
    'Post a message to the Agorai discussion thread for a topic.',
    {
      topicId: z.string().describe('Topic UUID'),
      content: z.string().min(1).max(10000).describe('Message content'),
      level: z.number().optional().describe('Message level (default 1)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        if (await injectionTracker.isBlocked(account.id)) {
          return mcpError(Object.assign(new Error('Your discussion privileges are suspended pending review.'), { code: 'DISCUSSION_BLOCKED' }));
        }
        const detection = analyzeUserInput(params.content, 'discussion.content', {
          topicId: params.topicId,
          accountId: account.id,
        });
        const tracking = await injectionTracker.recordDetection(
          account.id, detection, 'discussion.content', buildPreview(params.content, detection.matches)
        );
        if (tracking.blocked) {
          return mcpError(Object.assign(new Error('Your discussion privileges are suspended pending review.'), { code: 'DISCUSSION_BLOCKED' }));
        }
        const message = await topicAgorai.postToDiscussion(params.topicId, {
          content: params.content,
          accountId: account.id,
          accountName: account.name || account.id,
          level: params.level || 1,
        });
        if (!message) {
          return mcpError(Object.assign(new Error('Topic not found or discussion unavailable'), { code: 'NOT_FOUND' }));
        }
        return mcpResult({
          id: message.id,
          content: message.content,
          message: 'Posted to discussion.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  return tools;
}

module.exports = { CATEGORY, registerTools };
