'use strict';

const { z } = require('zod');
const aiProviderService = require('../../services/ai-provider');
const aiActionService = require('../../services/ai-action');
const { requireAccount, mcpResult, mcpError } = require('../helpers');

const CATEGORY = 'ai_integration';

function registerTools(server, getSessionAccount) {
  const tools = {};

  // ─── PROVIDERS ────────────────────────────────────────────────────

  tools.list_provider_types = server.tool(
    'list_provider_types',
    'List available AI provider types (e.g. OpenAI-compatible, Claude).',
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async () => {
      try {
        const types = aiProviderService.getProviderTypes
          ? aiProviderService.getProviderTypes()
          : [];
        return mcpResult({ types });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.create_provider = server.tool(
    'create_provider',
    'Configure an AI provider (LLM) for assisted agent actions. Human root accounts only.',
    {
      name: z.string().describe('Provider display name'),
      providerType: z.string().describe('Provider type ID'),
      model: z.string().describe('Model name (e.g. claude-sonnet-4-20250514)'),
      apiKey: z.string().describe('API key for the provider'),
      apiEndpoint: z.string().optional().describe('Custom API endpoint URL'),
      systemPrompt: z.string().optional().describe('Default system prompt'),
      maxTokens: z.number().min(1).max(100000).optional().describe('Max tokens (default varies by provider)'),
      temperature: z.number().min(0).max(2).optional().describe('Temperature (default varies by provider)'),
      isDefault: z.boolean().optional().describe('Set as default provider'),
      endpointKind: z.enum(['llm', 'agent']).optional().describe('Endpoint kind: llm for chat-completions, agent for webhook dispatch (custom providers only)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const provider = await aiProviderService.createProvider({
          accountId: account.id,
          name: params.name,
          providerType: params.providerType,
          model: params.model,
          apiKey: params.apiKey,
          apiEndpoint: params.apiEndpoint || null,
          systemPrompt: params.systemPrompt || null,
          maxTokens: params.maxTokens,
          temperature: params.temperature,
          isDefault: params.isDefault,
          endpointKind: params.endpointKind,
        });
        return mcpResult({
          id: provider.id,
          name: provider.name,
          providerType: provider.provider_type,
          model: provider.model,
          isDefault: provider.is_default,
          endpointKind: provider.endpoint_kind,
          message: 'Provider created.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.list_providers = server.tool(
    'list_providers',
    'List your configured AI providers.',
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (_params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const providers = await aiProviderService.listProviders(account.id);
        return mcpResult({
          providers: providers.map(p => ({
            id: p.id,
            name: p.name,
            providerType: p.provider_type,
            model: p.model,
            apiEndpoint: p.api_endpoint,
            maxTokens: p.max_tokens,
            temperature: p.temperature,
            isDefault: p.is_default,
            endpointKind: p.endpoint_kind,
            createdAt: p.created_at,
          })),
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.update_provider = server.tool(
    'update_provider',
    'Update an AI provider configuration.',
    {
      providerId: z.string().describe('Provider UUID'),
      name: z.string().optional().describe('New name'),
      providerType: z.string().optional().describe('New provider type'),
      model: z.string().optional().describe('New model'),
      apiKey: z.string().optional().describe('New API key'),
      apiEndpoint: z.string().optional().describe('New endpoint URL'),
      systemPrompt: z.string().optional().describe('New system prompt'),
      maxTokens: z.number().min(1).max(100000).optional().describe('New max tokens'),
      temperature: z.number().min(0).max(2).optional().describe('New temperature'),
      isDefault: z.boolean().optional().describe('Set as default'),
      endpointKind: z.enum(['llm', 'agent']).optional().describe('Endpoint kind (custom providers only)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const updated = await aiProviderService.updateProvider(params.providerId, account.id, {
          name: params.name,
          providerType: params.providerType,
          model: params.model,
          apiKey: params.apiKey,
          apiEndpoint: params.apiEndpoint,
          systemPrompt: params.systemPrompt,
          maxTokens: params.maxTokens,
          temperature: params.temperature,
          isDefault: params.isDefault,
          endpointKind: params.endpointKind,
        });
        if (!updated) {
          return mcpError(Object.assign(new Error('Provider not found'), { code: 'NOT_FOUND' }));
        }
        return mcpResult({
          id: updated.id,
          name: updated.name,
          model: updated.model,
          message: 'Provider updated.',
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.delete_provider = server.tool(
    'delete_provider',
    'Delete an AI provider configuration.',
    {
      providerId: z.string().describe('Provider UUID'),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const deleted = await aiProviderService.deleteProvider(params.providerId, account.id);
        if (!deleted) {
          return mcpError(Object.assign(new Error('Provider not found'), { code: 'NOT_FOUND' }));
        }
        return mcpResult({ message: 'Provider deleted.' });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.test_provider = server.tool(
    'test_provider',
    'Test connectivity to an AI provider by sending a simple prompt.',
    {
      providerId: z.string().describe('Provider UUID'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const provider = await aiProviderService.getProviderById(params.providerId);
        if (!provider || provider.account_id !== account.id) {
          return mcpError(Object.assign(new Error('Provider not found'), { code: 'NOT_FOUND' }));
        }
        const result = await aiProviderService.callProvider(provider, [
          { role: 'user', content: 'Reply with "OK" to confirm connectivity.' },
        ]);
        return mcpResult({
          success: true,
          response: result.content,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // ─── ACTIONS ──────────���───────────────────────────────────────────

  tools.execute_action = server.tool(
    'execute_action',
    'Execute an AI action (summary, contribute, review, reply, draft) via an assisted agent.',
    {
      agentId: z.string().describe('Assisted agent sub-account UUID'),
      actionType: z.enum(['summary', 'contribute', 'review', 'reply', 'draft']).describe('Action type'),
      targetType: z.enum(['topic', 'chunk', 'discussion', 'search']).optional().describe('Target type'),
      targetId: z.string().optional().describe('Target UUID'),
      providerId: z.string().optional().describe('Provider UUID (optional, uses default if omitted)'),
      context: z.record(z.unknown()).optional().describe('Additional context object'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const result = await aiActionService.executeAction({
          agentId: params.agentId,
          parentId: account.id,
          providerId: params.providerId || null,
          actionType: params.actionType,
          targetType: params.targetType || null,
          targetId: params.targetId || null,
          context: params.context || {},
        });
        return mcpResult({
          actionId: result.actionId,
          result: result.result,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.get_action_history = server.tool(
    'get_action_history',
    'Get AI action history for your account.',
    {
      limit: z.number().optional().describe('Max results (default 20, max 100)'),
      offset: z.number().optional().describe('Offset (default 0)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        const actions = await aiActionService.getActionHistory(account.id, {
          limit: Math.min(params.limit || 20, 100),
          offset: params.offset || 0,
        });
        return mcpResult({
          actions: actions.map(a => ({
            id: a.id,
            actionType: a.action_type,
            targetType: a.target_type,
            targetId: a.target_id,
            status: a.status,
            inputTokens: a.input_tokens,
            outputTokens: a.output_tokens,
            agentName: a.agent_name,
            providerName: a.provider_name,
            createdAt: a.created_at,
            completedAt: a.completed_at,
          })),
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  tools.dispatch_action = server.tool(
    'dispatch_action',
    'Dispatch an AI action result as contributions (chunks, messages, flags).',
    {
      actionId: z.string().describe('Action UUID'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (params, extra) => {
      try {
        const account = requireAccount(getSessionAccount, extra);
        // Fetch the action to get its details
        const actions = await aiActionService.getActionHistory(account.id, { limit: 100, offset: 0 });
        const action = actions.find(a => a.id === params.actionId);
        if (!action) {
          return mcpError(Object.assign(new Error('Action not found'), { code: 'NOT_FOUND' }));
        }
        const result = await aiActionService.dispatchResult({
          actionId: params.actionId,
          agentId: action.agent_id,
          actionType: action.action_type,
          targetType: action.target_type,
          targetId: action.target_id,
          result: action.result,
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
