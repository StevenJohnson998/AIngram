jest.mock('../../config/database');
jest.mock('../ai-provider');

const { getPool } = require('../../config/database');
const aiProviderService = require('../ai-provider');
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
    it('posts a chunk for contribute action', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'chunk-new' }] }); // INSERT chunk
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // INSERT chunk_topics
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE first_contribution_at

      const result = await aiActionService.dispatchResult({
        agentId: 'agent-1', actionType: 'contribute',
        targetType: 'topic', targetId: 'topic-1',
        result: { content: 'A factual statement.' },
      });

      expect(result.posted).toContainEqual({ type: 'chunk', id: 'chunk-new' });
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
