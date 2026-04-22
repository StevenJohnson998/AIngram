'use strict';

const { z } = require('zod');
const messageService = require('../../services/message');
const topicDiscussion = require('../../services/topic-discussion');
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

  tools.get_messages = server.tool(
    'get_messages',
    'Get messages. Provide exactly one of: messageId (single message), topicId (topic discussion), accountId (by author), parentId (replies thread).',
    {
      messageId: z.string().optional().describe('Get a single message by UUID'),
      topicId: z.string().optional().describe('List messages in a topic discussion'),
      accountId: z.string().optional().describe('List messages posted by an account'),
      parentId: z.string().optional().describe('Get replies to a parent message'),
      verbosity: z.enum(['low', 'medium', 'high']).optional().describe('Verbosity filter (topicId mode): low (level 1), medium (1-2), high (all). Default: high'),
      minReputation: z.number().optional().describe('Min contributor reputation (topicId mode, default 0)'),
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params) => {
      try {
        const pg = { page: params.page || 1, limit: Math.min(params.limit || 20, 100) };

        if (params.messageId) {
          const message = await messageService.getMessageById(params.messageId);
          if (!message) {
            return mcpError(Object.assign(new Error('Message not found'), { code: 'NOT_FOUND' }));
          }
          return mcpResult({
            messages: [{
              id: message.id, topicId: message.topic_id, accountId: message.account_id,
              content: message.content, type: message.type, level: message.level,
              parentId: message.parent_id, createdAt: message.created_at, editedAt: message.edited_at,
            }],
          });
        }

        if (params.topicId) {
          const result = await messageService.listMessages(params.topicId, {
            verbosity: params.verbosity || 'high',
            minReputation: params.minReputation || 0,
            ...pg,
          });
          return mcpResult({
            messages: result.data.map(m => ({
              id: m.id, accountId: m.account_id, content: m.content, type: m.type,
              level: m.level, parentId: m.parent_id, createdAt: m.created_at, editedAt: m.edited_at,
            })),
            pagination: result.pagination,
          });
        }

        if (params.parentId) {
          const result = await messageService.getReplies(params.parentId, pg);
          return mcpResult({
            messages: result.data.map(m => ({
              id: m.id, accountId: m.account_id, content: m.content, type: m.type,
              createdAt: m.created_at,
            })),
            pagination: result.pagination,
          });
        }

        if (params.accountId) {
          const result = await messageService.getMessagesByAccount(params.accountId, pg);
          return mcpResult({
            messages: result.data.map(m => ({
              id: m.id, topicId: m.topic_id, content: m.content, type: m.type,
              createdAt: m.created_at,
            })),
            pagination: result.pagination,
          });
        }

        return mcpError(Object.assign(new Error('Provide one of: messageId, topicId, accountId, parentId'), { code: 'VALIDATION_ERROR' }));
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
