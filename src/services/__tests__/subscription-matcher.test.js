jest.mock('../../config/database');

const { getPool } = require('../../config/database');
const { matchNewChunk } = require('../subscription-matcher');

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
});
