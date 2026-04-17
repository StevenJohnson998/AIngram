jest.mock('../../config/database');
jest.mock('../ai-provider');
jest.mock('../chunk');
jest.mock('../mini-working-set', () => ({
  getRecentContributions: jest.fn().mockResolvedValue([]),
  renderForPrompt: jest.fn().mockReturnValue(''),
}));

const { getPool } = require('../../config/database');
const aiProviderService = require('../ai-provider');
const chunkService = require('../chunk');
const aiActionService = require('../ai-action');

describe('ai-action service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('executeAction', () => {
    const baseParams = {
      agentId: 'agent-1',
      parentId: 'parent-1',
      providerId: 'prov-1',
      actionType: 'review',
      targetType: 'chunk',
      targetId: 'chunk-1',
      context: { content: 'Test chunk content', topicTitle: 'Transformers' },
    };

    it('executes a review action and parses structured JSON response', async () => {
      const provider = {
        id: 'prov-1', account_id: 'parent-1', provider_type: 'claude',
        model: 'claude-sonnet-4-6', system_prompt: null, max_tokens: 1024, temperature: 0.7,
      };
      aiProviderService.getProviderById.mockResolvedValueOnce(provider);
      aiProviderService.callProvider.mockResolvedValueOnce({
        content: '{"content":"Good quality chunk","vote":"positive","flag":null,"confidence":0.9}',
        inputTokens: 100, outputTokens: 50,
      });

      // Agent name query
      mockPool.query.mockResolvedValueOnce({ rows: [{ name: 'ReviewBot' }] });
      // Insert action record
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'action-1' }] });
      // Update action record (completed)
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await aiActionService.executeAction(baseParams);

      expect(result.actionId).toBe('action-1');
      expect(result.result.vote).toBe('positive');
      expect(result.result.confidence).toBe(0.9);
      expect(result.inputTokens).toBe(100);
      expect(result.outputTokens).toBe(50);
    });

    it('wraps non-JSON review response in neutral result', async () => {
      const provider = {
        id: 'prov-1', account_id: 'parent-1', provider_type: 'claude',
        model: 'claude-sonnet-4-6', system_prompt: null, max_tokens: 1024, temperature: 0.7,
      };
      aiProviderService.getProviderById.mockResolvedValueOnce(provider);
      aiProviderService.callProvider.mockResolvedValueOnce({
        content: 'This chunk looks fine to me.',
        inputTokens: 80, outputTokens: 20,
      });

      mockPool.query.mockResolvedValueOnce({ rows: [{ name: 'Bot' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'action-2' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await aiActionService.executeAction(baseParams);

      expect(result.result.content).toBe('This chunk looks fine to me.');
      expect(result.result.vote).toBe('neutral');
      expect(result.result.confidence).toBe(0.5);
    });

    it('throws PROVIDER_REQUIRED when no provider configured', async () => {
      // Agent query (no provider_id assigned)
      mockPool.query.mockResolvedValueOnce({ rows: [{ name: 'Bot', description: null, provider_id: null }] });
      aiProviderService.getDefaultProvider.mockResolvedValueOnce(null);

      await expect(aiActionService.executeAction({
        ...baseParams, providerId: null,
      })).rejects.toThrow('No AI provider configured');
    });

    it('throws NOT_FOUND when provider belongs to different account', async () => {
      // Agent query
      mockPool.query.mockResolvedValueOnce({ rows: [{ name: 'Bot', description: null, provider_id: null }] });
      aiProviderService.getProviderById.mockResolvedValueOnce({
        id: 'prov-1', account_id: 'other-parent',
      });

      await expect(aiActionService.executeAction(baseParams))
        .rejects.toThrow('Provider not found or not owned by you');
    });

    it('records failure in DB when provider call fails', async () => {
      const provider = {
        id: 'prov-1', account_id: 'parent-1', provider_type: 'claude',
        model: 'claude-sonnet-4-6', system_prompt: null, max_tokens: 1024, temperature: 0.7,
      };
      aiProviderService.getProviderById.mockResolvedValueOnce(provider);
      aiProviderService.callProvider.mockRejectedValueOnce(new Error('API timeout'));

      mockPool.query.mockResolvedValueOnce({ rows: [{ name: 'Bot' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'action-3' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // failure update

      await expect(aiActionService.executeAction(baseParams)).rejects.toThrow('API timeout');

      // Verify failure was recorded
      const failureCall = mockPool.query.mock.calls[2];
      expect(failureCall[0]).toContain("status = 'failed'");
      expect(failureCall[1][0]).toBe('API timeout');
    });
  });

  describe('dispatchResult', () => {
    it('posts a chunk for contribute action via chunkService', async () => {
      chunkService.createChunk.mockResolvedValueOnce({ id: 'chunk-new', content: 'A factual statement.' });
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE first_contribution_at

      const result = await aiActionService.dispatchResult({
        agentId: 'agent-1', actionType: 'contribute',
        targetType: 'topic', targetId: 'topic-1',
        result: { content: 'A factual statement.' },
      });

      expect(result.posted).toContainEqual({ type: 'chunk', id: 'chunk-new' });
      expect(chunkService.createChunk).toHaveBeenCalledWith({
        content: 'A factual statement.',
        technicalDetail: null,
        topicId: 'topic-1',
        createdBy: 'agent-1',
      });
    });

    it('posts multiple chunks for draft action', async () => {
      chunkService.createChunk
        .mockResolvedValueOnce({ id: 'chunk-1' })
        .mockResolvedValueOnce({ id: 'chunk-2' });
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE first_contribution_at

      const result = await aiActionService.dispatchResult({
        agentId: 'agent-1', actionType: 'draft',
        targetType: 'topic', targetId: 'topic-1',
        result: { summary: 'Article summary', chunks: [
          { content: 'Fact 1' },
          { content: 'Fact 2', technicalDetail: 'code here' },
        ]},
      });

      expect(result.posted).toHaveLength(2);
      expect(chunkService.createChunk).toHaveBeenCalledTimes(2);
    });

    it('collects errors when some chunks fail in draft', async () => {
      chunkService.createChunk
        .mockResolvedValueOnce({ id: 'chunk-1' })
        .mockRejectedValueOnce(Object.assign(new Error('Duplicate'), { code: 'DUPLICATE_CONTENT' }));
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE first_contribution_at

      const result = await aiActionService.dispatchResult({
        agentId: 'agent-1', actionType: 'draft',
        targetType: 'topic', targetId: 'topic-1',
        result: { summary: 'test', chunks: [
          { content: 'Fact 1' },
          { content: 'Fact 2' },
        ]},
      });

      expect(result.posted).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('Duplicate');
    });

    it('posts a message for reply action', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'msg-new' }] }); // INSERT message

      const result = await aiActionService.dispatchResult({
        agentId: 'agent-1', actionType: 'reply',
        targetType: 'topic', targetId: 'topic-1',
        result: { content: 'Great discussion!' },
      });

      expect(result.posted).toContainEqual({ type: 'message', id: 'msg-new' });
    });

    it('posts flag and review message for negative review with flag', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'action-1' }] }); // idempotency check
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // INSERT flag
      mockPool.query.mockResolvedValueOnce({ rows: [{ topic_id: 'topic-1' }] }); // find topic
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'msg-review' }] }); // INSERT message
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // mark dispatched

      const result = await aiActionService.dispatchResult({
        actionId: 'action-1',
        agentId: 'agent-1', actionType: 'review',
        targetType: 'chunk', targetId: 'chunk-1',
        result: { content: 'This is spam', vote: 'negative', flag: 'spam', confidence: 0.95 },
      });

      expect(result.posted).toContainEqual({ type: 'flag', reason: 'spam' });
      expect(result.posted).toContainEqual(expect.objectContaining({ type: 'message' }));
    });

    it('posts only review message for neutral review (no flag)', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'action-2' }] }); // idempotency check
      mockPool.query.mockResolvedValueOnce({ rows: [{ topic_id: 'topic-1' }] }); // find topic
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'msg-review' }] }); // INSERT message
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // mark dispatched

      const result = await aiActionService.dispatchResult({
        actionId: 'action-2',
        agentId: 'agent-1', actionType: 'review',
        targetType: 'chunk', targetId: 'chunk-1',
        result: { content: 'Looks reasonable', vote: 'neutral', flag: null },
      });

      expect(result.posted.find(p => p.type === 'flag')).toBeUndefined();
      expect(result.posted).toContainEqual(expect.objectContaining({ type: 'message' }));
    });

    it('returns alreadyDispatched when action was already dispatched', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // idempotency check = no rows = already dispatched

      const result = await aiActionService.dispatchResult({
        actionId: 'action-old',
        agentId: 'agent-1', actionType: 'review',
        targetType: 'chunk', targetId: 'chunk-1',
        result: { content: 'test' },
      });

      expect(result.alreadyDispatched).toBe(true);
      expect(result.posted).toHaveLength(0);
    });

    it('dispatches discuss_proposal as message on the changeset topic', async () => {
      // idempotency check
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'action-dp' }] });
      // SELECT topic_id FROM changesets
      mockPool.query.mockResolvedValueOnce({ rows: [{ topic_id: 'topic-42' }] });
      // INSERT message
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'msg-dp' }] });
      // mark dispatched
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await aiActionService.dispatchResult({
        actionId: 'action-dp',
        agentId: 'agent-1',
        actionType: 'discuss_proposal',
        targetType: 'changeset',
        targetId: 'cs-abcdef12-3456-7890',
        result: { content: 'I approve this change because it improves accuracy.' },
      });

      expect(result.posted).toContainEqual(expect.objectContaining({ type: 'message', id: 'msg-dp' }));
      // Verify the message content includes the changeset prefix
      const insertCall = mockPool.query.mock.calls.find(c => c[0].includes('INSERT INTO messages'));
      expect(insertCall[1][2]).toContain('Re: proposal (changeset cs-abcde');
      expect(insertCall[1][2]).toContain('I approve this change');
      expect(insertCall[1][0]).toBe('topic-42');
    });

  });

  describe('discuss_proposal action', () => {
    it('executes with enriched context (article + proposal + discussion)', async () => {
      const provider = {
        id: 'prov-1', account_id: 'parent-1', provider_type: 'claude',
        model: 'claude-sonnet-4-6', system_prompt: null, max_tokens: 1024, temperature: 0.7,
      };
      aiProviderService.getProviderById.mockResolvedValueOnce(provider);
      aiProviderService.callProvider.mockResolvedValueOnce({
        content: 'I approve this proposal. The added content is factual and well-sourced.',
        inputTokens: 200, outputTokens: 60,
      });

      mockPool.query.mockResolvedValueOnce({ rows: [{ name: 'DiscussBot', description: null }] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'action-dp' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await aiActionService.executeAction({
        agentId: 'agent-1',
        parentId: 'parent-1',
        providerId: 'prov-1',
        actionType: 'discuss_proposal',
        targetType: 'changeset',
        targetId: 'cs-123',
        context: {
          topicTitle: 'Transformer Architecture',
          articleContent: 'Chunk 1: Transformers use self-attention.\nChunk 2: BERT is bidirectional.',
          proposalDescription: 'Add information about GPT-4',
          operations: [{ operation: 'add', content: 'GPT-4 uses a MoE architecture.' }],
          discussionHistory: [{ name: 'Agent-X', content: 'Interesting proposal.' }],
        },
      });

      expect(result.result.content).toContain('approve');
      // Verify the prompt sent to the provider includes article and proposal context
      const callArgs = aiProviderService.callProvider.mock.calls[0][1];
      const userMsg = callArgs.find(m => m.role === 'user');
      expect(userMsg.content).toContain('Transformer Architecture');
      expect(userMsg.content).toContain('Current article');
      expect(userMsg.content).toContain('Proposed change');
      expect(userMsg.content).toContain('ADD: GPT-4 uses a MoE architecture');
      expect(userMsg.content).toContain('[Agent-X]: Interesting proposal');
    });
  });

  describe('buildSystemPrompt archetype injection', () => {
    const provider = { system_prompt: null };
    it('injects Sentinel blurb when archetype=sentinel', () => {
      const sp = aiActionService.buildSystemPrompt(provider, 'Bot', 'review', null, 'sentinel');
      expect(sp).toContain('Archetype **Sentinel**');
      expect(sp).toContain('flag queues');
    });
    it('injects Curator blurb when archetype=curator', () => {
      const sp = aiActionService.buildSystemPrompt(provider, 'Bot', 'review', null, 'curator');
      expect(sp).toContain('Archetype **Curator**');
    });
    it('omits the archetype block when archetype is null', () => {
      const sp = aiActionService.buildSystemPrompt(provider, 'Bot', 'review', null, null);
      expect(sp).not.toContain('Archetype **');
    });
    it('omits the archetype block when archetype is unknown', () => {
      const sp = aiActionService.buildSystemPrompt(provider, 'Bot', 'review', null, 'wizard');
      expect(sp).not.toContain('Archetype **');
    });
    it('stacks archetype blurb and persona description in order', () => {
      const sp = aiActionService.buildSystemPrompt(provider, 'Bot', 'review', 'Focus on transformers papers.', 'teacher');
      expect(sp).toContain('Archetype **Teacher**');
      expect(sp).toContain('Focus on transformers papers.');
      expect(sp.indexOf('Archetype **Teacher**')).toBeLessThan(sp.indexOf('Focus on transformers papers.'));
    });
    it('appends workingSetText when provided (LLM mode mini-working-set)', () => {
      const ws = 'Your recent contributions (avoid duplicating these):\n- Chunk A [2026-04-10]';
      const sp = aiActionService.buildSystemPrompt(provider, 'Bot', 'review', null, null, ws);
      expect(sp).toContain('Your recent contributions');
      expect(sp).toContain('- Chunk A [2026-04-10]');
    });
    it('does not append anything when workingSetText is empty', () => {
      const sp = aiActionService.buildSystemPrompt(provider, 'Bot', 'review', null, null, '');
      expect(sp).not.toContain('Your recent contributions');
    });
  });

  describe('endpoint_kind routing (D96)', () => {
    const baseParams = {
      agentId: 'agent-1',
      parentId: 'parent-1',
      providerId: null,
      actionType: 'contribute',
      targetType: 'topic',
      targetId: 'topic-1',
      context: { topicTitle: 'Transformers' },
    };

    const agentProvider = {
      id: 'prov-agent-1', account_id: 'parent-1', provider_type: 'custom',
      model: 'agent-webhook', endpoint_kind: 'agent', name: 'My Agent Webhook',
      system_prompt: null, max_tokens: 1024, temperature: 0.7,
    };

    it('stages a slim envelope when provider.endpoint_kind=agent', async () => {
      // Agent fetch
      mockPool.query.mockResolvedValueOnce({
        rows: [{ name: 'AgentBot', description: null, provider_id: null, primary_archetype: null }],
      });
      // Provider resolved via getDefaultProvider
      aiProviderService.getDefaultProvider.mockResolvedValueOnce(agentProvider);
      // Insert action record (agent mode branch)
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'action-agent-1' }] });

      const result = await aiActionService.executeAction(baseParams);

      expect(result.dispatchMode).toBe('agent');
      expect(result.result.status).toBe('pending_agent_dispatch');
      expect(result.result.envelope).toEqual({
        action: 'contribute',
        target: { type: 'topic', id: 'topic-1' },
        context: { topicTitle: 'Transformers' },
      });
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      // Provider is resolved but callProvider must not be called in agent mode
      expect(aiProviderService.callProvider).not.toHaveBeenCalled();
      // Insert should carry provider.id (not NULL) and status='pending'
      const insertCall = mockPool.query.mock.calls[1];
      expect(insertCall[0]).toContain('INSERT INTO ai_actions');
      expect(insertCall[0]).toContain("'pending'");
      expect(insertCall[1]).toContain('prov-agent-1');
    });

    it('defaults to llm when provider has no endpoint_kind property', async () => {
      const provider = {
        id: 'prov-1', account_id: 'parent-1', provider_type: 'claude',
        model: 'claude', system_prompt: null, max_tokens: 1024, temperature: 0.7,
      };
      aiProviderService.getDefaultProvider.mockResolvedValueOnce(provider);
      aiProviderService.callProvider.mockResolvedValueOnce({
        content: '{"content":"ok","vote":"positive","flag":null,"confidence":0.9}',
        inputTokens: 10, outputTokens: 5,
      });

      mockPool.query.mockResolvedValueOnce({
        rows: [{ name: 'Bot', description: null, provider_id: null, primary_archetype: null }],
      });
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'action-llm-1' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await aiActionService.executeAction({ ...baseParams, actionType: 'review', targetType: 'chunk', targetId: 'chunk-1', context: { content: 'x' } });
      expect(result.dispatchMode).toBe('llm');
      expect(aiProviderService.callProvider).toHaveBeenCalled();
    });

    it('injects mini-working-set text into system prompt in llm mode', async () => {
      const miniWorkingSet = require('../mini-working-set');
      miniWorkingSet.getRecentContributions.mockResolvedValueOnce([
        { id: 'c1', title: 'Past chunk', subtitle: null, createdAt: new Date('2026-04-10T00:00:00Z') },
      ]);
      miniWorkingSet.renderForPrompt.mockReturnValueOnce('RECENT_WORK_MARKER');

      const provider = {
        id: 'prov-1', account_id: 'parent-1', provider_type: 'claude',
        model: 'claude', system_prompt: null, max_tokens: 1024, temperature: 0.7,
      };
      aiProviderService.getDefaultProvider.mockResolvedValueOnce(provider);
      aiProviderService.callProvider.mockResolvedValueOnce({
        content: '{"content":"ok","vote":"positive","flag":null,"confidence":0.9}',
        inputTokens: 1, outputTokens: 1,
      });

      mockPool.query.mockResolvedValueOnce({
        rows: [{ name: 'Bot', description: null, provider_id: null, primary_archetype: null }],
      });
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'action-ws-1' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await aiActionService.executeAction({ ...baseParams, actionType: 'review', targetType: 'chunk', targetId: 'chunk-1', context: { content: 'x' } });

      expect(miniWorkingSet.getRecentContributions).toHaveBeenCalledWith('agent-1');
      const [, messages] = aiProviderService.callProvider.mock.calls[0];
      const systemMessage = messages.find(m => m.role === 'system');
      expect(systemMessage.content).toContain('RECENT_WORK_MARKER');
    });

    it('snapshots provider.model into ai_actions.model_used in llm mode', async () => {
      const provider = {
        id: 'prov-1', account_id: 'parent-1', provider_type: 'deepseek',
        model: 'deepseek-chat-v3.1', system_prompt: null, max_tokens: 1024, temperature: 0.7,
      };
      aiProviderService.getDefaultProvider.mockResolvedValueOnce(provider);
      aiProviderService.callProvider.mockResolvedValueOnce({
        content: '{"content":"ok","vote":"positive","flag":null,"confidence":0.9}',
        inputTokens: 1, outputTokens: 1,
      });

      mockPool.query.mockResolvedValueOnce({
        rows: [{ name: 'Bot', description: null, provider_id: null, primary_archetype: null }],
      });
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'action-model-1' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await aiActionService.executeAction({ ...baseParams, actionType: 'review', targetType: 'chunk', targetId: 'chunk-1', context: { content: 'x' } });

      const insertCall = mockPool.query.mock.calls[1];
      expect(insertCall[0]).toContain('model_used');
      // model_used is the last parameter, snapshot of provider.model
      expect(insertCall[1][insertCall[1].length - 1]).toBe('deepseek-chat-v3.1');
    });

    it('uses caller-supplied agentModel when present (llm mode override)', async () => {
      const provider = {
        id: 'prov-1', account_id: 'parent-1', provider_type: 'openai',
        model: 'gpt-4o', system_prompt: null, max_tokens: 1024, temperature: 0.7,
      };
      aiProviderService.getDefaultProvider.mockResolvedValueOnce(provider);
      aiProviderService.callProvider.mockResolvedValueOnce({
        content: '{"content":"ok","vote":"positive","flag":null,"confidence":0.9}',
        inputTokens: 1, outputTokens: 1,
      });

      mockPool.query.mockResolvedValueOnce({
        rows: [{ name: 'Bot', description: null, provider_id: null, primary_archetype: null }],
      });
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'action-model-2' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await aiActionService.executeAction({
        ...baseParams, actionType: 'review', targetType: 'chunk', targetId: 'chunk-1', context: { content: 'x' },
        agentModel: 'gpt-4o-mini-2025-01',
      });

      const insertCall = mockPool.query.mock.calls[1];
      expect(insertCall[1][insertCall[1].length - 1]).toBe('gpt-4o-mini-2025-01');
    });

    it('records agentModel into ai_actions.model_used in agent mode', async () => {
      const agentProv = {
        id: 'prov-agent-m1', account_id: 'parent-1', provider_type: 'custom',
        model: 'agent-webhook', endpoint_kind: 'agent', name: 'Webhook',
        system_prompt: null, max_tokens: 1024, temperature: 0.7,
      };
      mockPool.query.mockResolvedValueOnce({
        rows: [{ name: 'AgentBot', description: null, provider_id: null, primary_archetype: null }],
      });
      aiProviderService.getDefaultProvider.mockResolvedValueOnce(agentProv);
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'action-agent-m1' }] });

      await aiActionService.executeAction({ ...baseParams, agentModel: 'claude-opus-4-6' });

      const insertCall = mockPool.query.mock.calls[1];
      expect(insertCall[0]).toContain('model_used');
      // agentModel overrides provider.model
      expect(insertCall[1][insertCall[1].length - 1]).toBe('claude-opus-4-6');
    });

    it('stores provider.model as model_used in agent mode when no agentModel declared', async () => {
      const agentProv = {
        id: 'prov-agent-m2', account_id: 'parent-1', provider_type: 'custom',
        model: 'agent-webhook', endpoint_kind: 'agent', name: 'Webhook',
        system_prompt: null, max_tokens: 1024, temperature: 0.7,
      };
      mockPool.query.mockResolvedValueOnce({
        rows: [{ name: 'AgentBot', description: null, provider_id: null, primary_archetype: null }],
      });
      aiProviderService.getDefaultProvider.mockResolvedValueOnce(agentProv);
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'action-agent-m2' }] });

      await aiActionService.executeAction(baseParams);

      const insertCall = mockPool.query.mock.calls[1];
      // Falls back to provider.model since no agentModel
      expect(insertCall[1][insertCall[1].length - 1]).toBe('agent-webhook');
    });

    it('swallows mini-working-set errors (best-effort)', async () => {
      const miniWorkingSet = require('../mini-working-set');
      miniWorkingSet.getRecentContributions.mockRejectedValueOnce(new Error('db down'));
      miniWorkingSet.renderForPrompt.mockReturnValue('');

      const provider = {
        id: 'prov-1', account_id: 'parent-1', provider_type: 'claude',
        model: 'claude', system_prompt: null, max_tokens: 1024, temperature: 0.7,
      };
      aiProviderService.getDefaultProvider.mockResolvedValueOnce(provider);
      aiProviderService.callProvider.mockResolvedValueOnce({
        content: '{"content":"ok","vote":"positive","flag":null,"confidence":0.9}',
        inputTokens: 1, outputTokens: 1,
      });

      mockPool.query.mockResolvedValueOnce({
        rows: [{ name: 'Bot', description: null, provider_id: null, primary_archetype: null }],
      });
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'action-wserr-1' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      // Should NOT throw even when working-set fetch fails
      await expect(aiActionService.executeAction({ ...baseParams, actionType: 'review', targetType: 'chunk', targetId: 'chunk-1', context: { content: 'x' } })).resolves.toBeDefined();
    });
  });

  describe('buildAgentTaskEnvelope', () => {
    it('returns action + target + context', () => {
      const env = aiActionService.buildAgentTaskEnvelope({
        actionType: 'draft', targetType: 'topic', targetId: 't1', context: { topicTitle: 'X' },
      });
      expect(env).toEqual({
        action: 'draft',
        target: { type: 'topic', id: 't1' },
        context: { topicTitle: 'X' },
      });
    });
    it('handles missing target and context', () => {
      const env = aiActionService.buildAgentTaskEnvelope({ actionType: 'summary' });
      expect(env).toEqual({ action: 'summary', target: null, context: {} });
    });
  });

  describe('getActionHistory', () => {
    it('returns paginated action history', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'a1', action_type: 'review', status: 'completed', agent_name: 'Bot', provider_name: 'Claude' },
          { id: 'a2', action_type: 'contribute', status: 'failed', agent_name: 'Bot', provider_name: 'Claude' },
        ],
      });

      const result = await aiActionService.getActionHistory('parent-1', { limit: 10, offset: 0 });
      expect(result).toHaveLength(2);
      expect(result[0].action_type).toBe('review');
    });
  });
});
