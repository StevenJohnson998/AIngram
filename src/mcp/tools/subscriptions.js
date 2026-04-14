'use strict';

const { z } = require('zod');
const subscriptionService = require('../../services/subscription');
const notificationService = require('../../services/notification');
const { requireAccount, requireBadge, mcpResult, mcpError } = require('../helpers');

const CATEGORY = 'subscriptions';

function registerTools(server, getSessionAccount) {
  const tools = {};

  tools.list_subscriptions = server.tool(
    'list_subscriptions',
    'List your active subscriptions.',
    {
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const result = await subscriptionService.listMySubscriptions(account.id, {
          page: params.page || 1,
          limit: Math.min(params.limit || 20, 100),
        });
        return mcpResult({
          subscriptions: result.data.map(s => ({
            id: s.id,
            type: s.type,
            topicId: s.topic_id,
            keyword: s.keyword,
            similarityThreshold: s.similarity_threshold,
            lang: s.lang,
            notificationMethod: s.notification_method,
            webhookUrl: s.webhook_url,
            triggerStatus: s.trigger_status,
            active: s.active,
            createdAt: s.created_at,
          })),
          pagination: result.pagination,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_subscription = server.tool(
    'get_subscription',
    'Get a subscription by ID (must be yours).',
    {
      subscriptionId: z.string().describe('Subscription UUID'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const sub = await subscriptionService.getSubscriptionById(params.subscriptionId);
        if (!sub || sub.account_id !== account.id) {
          return mcpError(Object.assign(new Error('Subscription not found'), { code: 'NOT_FOUND' }));
        }
        return mcpResult({
          id: sub.id,
          type: sub.type,
          topicId: sub.topic_id,
          keyword: sub.keyword,
          similarityThreshold: sub.similarity_threshold,
          lang: sub.lang,
          notificationMethod: sub.notification_method,
          webhookUrl: sub.webhook_url,
          triggerStatus: sub.trigger_status,
          active: sub.active,
          createdAt: sub.created_at,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.update_subscription = server.tool(
    'update_subscription',
    'Update a subscription (threshold, webhook URL, active status, language, trigger).',
    {
      subscriptionId: z.string().describe('Subscription UUID'),
      similarityThreshold: z.number().min(0).max(1).optional().describe('New similarity threshold (0-1)'),
      webhookUrl: z.string().optional().describe('New webhook URL'),
      active: z.boolean().optional().describe('Enable/disable subscription'),
      lang: z.string().optional().describe('Language filter'),
      triggerStatus: z.enum(['published', 'proposed', 'both']).optional().describe('When to trigger'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const updated = await subscriptionService.updateSubscription(params.subscriptionId, account.id, {
          similarityThreshold: params.similarityThreshold,
          webhookUrl: params.webhookUrl,
          active: params.active,
          lang: params.lang,
          triggerStatus: params.triggerStatus,
        });
        return mcpResult({
          id: updated.id,
          active: updated.active,
          message: 'Subscription updated.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.delete_subscription = server.tool(
    'delete_subscription',
    'Delete a subscription.',
    {
      subscriptionId: z.string().describe('Subscription UUID'),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        await subscriptionService.deleteSubscription(params.subscriptionId, account.id);
        return mcpResult({ message: 'Subscription deleted.' });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // poll_notifications moved to core tools (always available)

  tools.get_dead_letters = server.tool(
    'get_dead_letters',
    'List failed webhook deliveries (dead-letter queue). Requires policing badge.',
    {
      page: z.number().optional().describe('Page (default 1)'),
      limit: z.number().optional().describe('Per page (default 20, max 100)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        requireBadge(account, 'policing');
        const result = await notificationService.listDeadLetters({
          page: params.page || 1,
          limit: Math.min(params.limit || 20, 100),
        });
        return mcpResult({
          deadLetters: result.data.map(dl => ({
            id: dl.id,
            subscriptionId: dl.subscription_id,
            webhookUrl: dl.webhook_url,
            attempts: dl.attempts,
            maxAttempts: dl.max_attempts,
            lastError: dl.last_error,
            createdAt: dl.created_at,
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
