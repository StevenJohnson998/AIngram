jest.mock('../../config/database');

const { getPool } = require('../../config/database');
const { matchNewChunk, filterByAdhp } = require('../subscription-matcher');

describe('subscription-matcher', () => {
  let mockPool;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
    };
    getPool.mockReturnValue(mockPool);
    jest.clearAllMocks();
  });

  const CHUNK_ID = 'chunk-123';
  const CHUNK_WITH_EMBEDDING = {
    id: CHUNK_ID,
    content: 'Machine learning algorithms for natural language processing',
    embedding: '[0.1,0.2,0.3]',
  };

  describe('vector subscription matching', () => {
    it('finds vector subscriptions above similarity threshold', async () => {
      mockPool.query
        // Get chunk
        .mockResolvedValueOnce({ rows: [CHUNK_WITH_EMBEDDING] })
        // Get chunk topics
        .mockResolvedValueOnce({ rows: [] })
        // Vector subs
        .mockResolvedValueOnce({
          rows: [
            { subscription_id: 'sub-1', account_id: 'acc-1', similarity: 0.85 },
          ],
        })
        // Keyword subs
        .mockResolvedValueOnce({ rows: [] });

      const matches = await matchNewChunk(CHUNK_ID);

      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        subscriptionId: 'sub-1',
        accountId: 'acc-1',
        matchType: 'vector',
        similarity: 0.85,
      });
    });

    it('skips vector matching when chunk has no embedding', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ ...CHUNK_WITH_EMBEDDING, embedding: null }] })
        .mockResolvedValueOnce({ rows: [] })
        // No vector query expected — goes straight to keyword
        .mockResolvedValueOnce({ rows: [] });

      const matches = await matchNewChunk(CHUNK_ID);

      expect(matches).toHaveLength(0);
      // Should not have queried vector subscriptions
      const vectorQueryCalled = mockPool.query.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.includes('<=>')
      );
      expect(vectorQueryCalled).toBe(false);
    });
  });

  describe('keyword subscription matching', () => {
    it('matches keyword subscriptions via ILIKE on content', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ ...CHUNK_WITH_EMBEDDING, embedding: null }] })
        .mockResolvedValueOnce({ rows: [] })
        // Keyword subs
        .mockResolvedValueOnce({
          rows: [
            { subscription_id: 'sub-kw1', account_id: 'acc-2', keyword: 'machine learning' },
            { subscription_id: 'sub-kw2', account_id: 'acc-3', keyword: 'blockchain' },
          ],
        });

      const matches = await matchNewChunk(CHUNK_ID);

      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        subscriptionId: 'sub-kw1',
        accountId: 'acc-2',
        matchType: 'keyword',
      });
    });

    it('keyword matching is case-insensitive', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ ...CHUNK_WITH_EMBEDDING, embedding: null }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { subscription_id: 'sub-kw1', account_id: 'acc-2', keyword: 'MACHINE LEARNING' },
          ],
        });

      const matches = await matchNewChunk(CHUNK_ID);

      expect(matches).toHaveLength(1);
      expect(matches[0].matchType).toBe('keyword');
    });
  });

  describe('topic subscription matching', () => {
    it('matches topic subscriptions for chunk topics', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ ...CHUNK_WITH_EMBEDDING, embedding: null }] })
        // Chunk topics
        .mockResolvedValueOnce({ rows: [{ topic_id: 'topic-1' }, { topic_id: 'topic-2' }] })
        // Keyword subs (empty)
        .mockResolvedValueOnce({ rows: [] })
        // Topic subs
        .mockResolvedValueOnce({
          rows: [
            { subscription_id: 'sub-t1', account_id: 'acc-4', topic_id: 'topic-1' },
          ],
        });

      const matches = await matchNewChunk(CHUNK_ID);

      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        subscriptionId: 'sub-t1',
        accountId: 'acc-4',
        matchType: 'topic',
      });
    });

    it('skips topic matching when chunk has no topics', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ ...CHUNK_WITH_EMBEDDING, embedding: null }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const matches = await matchNewChunk(CHUNK_ID);

      expect(matches).toHaveLength(0);
      // Topic subscription query should not be called
      expect(mockPool.query).toHaveBeenCalledTimes(3);
    });
  });

  describe('combined matching', () => {
    it('returns matches from all three types', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [CHUNK_WITH_EMBEDDING] })
        .mockResolvedValueOnce({ rows: [{ topic_id: 'topic-1' }] })
        // Vector subs
        .mockResolvedValueOnce({
          rows: [{ subscription_id: 'sub-v', account_id: 'acc-1', similarity: 0.9 }],
        })
        // Keyword subs
        .mockResolvedValueOnce({
          rows: [{ subscription_id: 'sub-k', account_id: 'acc-2', keyword: 'natural language' }],
        })
        // Topic subs
        .mockResolvedValueOnce({
          rows: [{ subscription_id: 'sub-t', account_id: 'acc-3', topic_id: 'topic-1' }],
        });

      const matches = await matchNewChunk(CHUNK_ID);

      expect(matches).toHaveLength(3);
      const types = matches.map((m) => m.matchType);
      expect(types).toContain('vector');
      expect(types).toContain('keyword');
      expect(types).toContain('topic');
    });
  });

  it('returns empty array when chunk not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const matches = await matchNewChunk('nonexistent');

    expect(matches).toEqual([]);
  });

  describe('ADHP policy filtering', () => {
    const baseMatches = [
      { subscriptionId: 'sub-1', accountId: 'acc-1', matchType: 'keyword' },
      { subscriptionId: 'sub-2', accountId: 'acc-2', matchType: 'keyword' },
      { subscriptionId: 'sub-3', accountId: 'acc-3', matchType: 'topic' },
    ];

    it('skips filtering when chunk has no adhp profile (backward compatible)', async () => {
      const result = await filterByAdhp(null, baseMatches);
      expect(result).toEqual(baseMatches);
    });

    it('skips filtering when matches array is empty', async () => {
      const result = await filterByAdhp({ version: '0.2' }, []);
      expect(result).toEqual([]);
    });

    it('blocks accounts with no adhp profile when chunk has restrictions', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'acc-1', adhp: null },
          { id: 'acc-2', adhp: { version: '0.2', sensitivity_level: 3 } },
        ],
      });

      const chunkAdhp = { version: '0.2', sensitivity_level: 2 };
      const matches = [
        { subscriptionId: 'sub-1', accountId: 'acc-1', matchType: 'keyword' },
        { subscriptionId: 'sub-2', accountId: 'acc-2', matchType: 'keyword' },
      ];

      const result = await filterByAdhp(chunkAdhp, matches);

      expect(result).toHaveLength(1);
      expect(result[0].accountId).toBe('acc-2');
    });

    it('filters by sensitivity_level (chunk <= account)', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'acc-1', adhp: { version: '0.2', sensitivity_level: 1 } },
          { id: 'acc-2', adhp: { version: '0.2', sensitivity_level: 3 } },
          { id: 'acc-3', adhp: { version: '0.2', sensitivity_level: 5 } },
        ],
      });

      const chunkAdhp = { version: '0.2', sensitivity_level: 3 };
      const result = await filterByAdhp(chunkAdhp, baseMatches);

      expect(result).toHaveLength(2);
      expect(result.map(m => m.accountId)).toEqual(['acc-2', 'acc-3']);
    });

    it('blocks marketing agents when direct_marketing_opt_out is true', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'acc-1', adhp: { version: '0.2', purpose: 'marketing' } },
          { id: 'acc-2', adhp: { version: '0.2', purpose: 'scientific' } },
          { id: 'acc-3', adhp: { version: '0.2', purpose: 'general' } },
        ],
      });

      const chunkAdhp = { version: '0.2', direct_marketing_opt_out: true };
      const result = await filterByAdhp(chunkAdhp, baseMatches);

      expect(result).toHaveLength(2);
      expect(result.map(m => m.accountId)).toEqual(['acc-2', 'acc-3']);
    });

    it('blocks training agents when training_opt_out is true', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'acc-1', adhp: { version: '0.2', training_use: true } },
          { id: 'acc-2', adhp: { version: '0.2', training_use: false } },
          { id: 'acc-3', adhp: { version: '0.2' } },
        ],
      });

      const chunkAdhp = { version: '0.2', training_opt_out: true };
      const result = await filterByAdhp(chunkAdhp, baseMatches);

      expect(result).toHaveLength(2);
      expect(result.map(m => m.accountId)).toEqual(['acc-2', 'acc-3']);
    });

    it('blocks scientific agents when scientific_research_opt_out is true', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'acc-1', adhp: { version: '0.2', purpose: 'scientific' } },
          { id: 'acc-2', adhp: { version: '0.2', purpose: 'general' } },
          { id: 'acc-3', adhp: { version: '0.2', purpose: 'marketing' } },
        ],
      });

      const chunkAdhp = { version: '0.2', scientific_research_opt_out: true };
      const result = await filterByAdhp(chunkAdhp, baseMatches);

      expect(result).toHaveLength(2);
      expect(result.map(m => m.accountId)).toEqual(['acc-2', 'acc-3']);
    });

    it('filters by jurisdiction overlap', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'acc-1', adhp: { version: '0.2', jurisdiction: ['US'] } },
          { id: 'acc-2', adhp: { version: '0.2', jurisdiction: ['EU'] } },
          { id: 'acc-3', adhp: { version: '0.2', jurisdiction: ['EU', 'UK'] } },
        ],
      });

      const chunkAdhp = { version: '0.2', jurisdiction: ['EU'] };
      const result = await filterByAdhp(chunkAdhp, baseMatches);

      expect(result).toHaveLength(2);
      expect(result.map(m => m.accountId)).toEqual(['acc-2', 'acc-3']);
    });

    it('blocks accounts with no jurisdiction when chunk restricts it', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'acc-1', adhp: { version: '0.2' } },
        ],
      });

      const chunkAdhp = { version: '0.2', jurisdiction: ['EU'] };
      const matches = [{ subscriptionId: 'sub-1', accountId: 'acc-1', matchType: 'keyword' }];
      const result = await filterByAdhp(chunkAdhp, matches);

      expect(result).toHaveLength(0);
    });

    it('handles account jurisdiction as a string (not array)', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'acc-1', adhp: { version: '0.2', jurisdiction: 'EU' } },
        ],
      });

      const chunkAdhp = { version: '0.2', jurisdiction: ['EU', 'UK'] };
      const matches = [{ subscriptionId: 'sub-1', accountId: 'acc-1', matchType: 'keyword' }];
      const result = await filterByAdhp(chunkAdhp, matches);

      expect(result).toHaveLength(1);
    });

    it('applies multiple ADHP rules simultaneously', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          // Passes all checks
          { id: 'acc-1', adhp: { version: '0.2', sensitivity_level: 5, purpose: 'general', jurisdiction: ['EU'] } },
          // Fails sensitivity
          { id: 'acc-2', adhp: { version: '0.2', sensitivity_level: 1, purpose: 'general', jurisdiction: ['EU'] } },
          // Fails marketing opt-out
          { id: 'acc-3', adhp: { version: '0.2', sensitivity_level: 5, purpose: 'marketing', jurisdiction: ['EU'] } },
        ],
      });

      const chunkAdhp = {
        version: '0.2',
        sensitivity_level: 3,
        direct_marketing_opt_out: true,
        jurisdiction: ['EU'],
      };
      const result = await filterByAdhp(chunkAdhp, baseMatches);

      expect(result).toHaveLength(1);
      expect(result[0].accountId).toBe('acc-1');
    });

    it('integrates with matchNewChunk when chunk has adhp', async () => {
      const chunkAdhp = { version: '0.2', sensitivity_level: 2 };
      mockPool.query
        // Get chunk (with adhp)
        .mockResolvedValueOnce({ rows: [{ ...CHUNK_WITH_EMBEDDING, embedding: null, adhp: chunkAdhp }] })
        // Get chunk topics
        .mockResolvedValueOnce({ rows: [] })
        // Keyword subs
        .mockResolvedValueOnce({
          rows: [
            { subscription_id: 'sub-kw1', account_id: 'acc-1', keyword: 'machine learning' },
            { subscription_id: 'sub-kw2', account_id: 'acc-2', keyword: 'natural language' },
          ],
        })
        // ADHP filter: fetch accounts
        .mockResolvedValueOnce({
          rows: [
            { id: 'acc-1', adhp: { version: '0.2', sensitivity_level: 3 } },
            { id: 'acc-2', adhp: null }, // undeclared = blocked
          ],
        });

      const matches = await matchNewChunk(CHUNK_ID);

      expect(matches).toHaveLength(1);
      expect(matches[0].accountId).toBe('acc-1');
    });

    it('does not query accounts when chunk has no adhp (no extra query)', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ ...CHUNK_WITH_EMBEDDING, embedding: null, adhp: null }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ subscription_id: 'sub-kw1', account_id: 'acc-1', keyword: 'machine learning' }],
        });

      const matches = await matchNewChunk(CHUNK_ID);

      expect(matches).toHaveLength(1);
      // Only 3 queries: chunk, topics, keyword subs — no ADHP account query
      expect(mockPool.query).toHaveBeenCalledTimes(3);
    });
  });
});
