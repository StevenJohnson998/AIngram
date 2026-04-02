jest.mock('../../config/database');

const { getPool } = require('../../config/database');
const { matchNewChunk, filterByAdhp, deduplicateMatches } = require('../subscription-matcher');

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

  /**
   * Helper: set up mocks for matchNewChunk.
   * Since predicates run in parallel, we use mockImplementation to route by SQL content.
   */
  function setupMocks({ chunk, topicIds = [], vectorResults = [], keywordResults = [], topicResults = [] }) {
    let callIndex = 0;
    mockPool.query.mockImplementation((sql, params) => {
      // First call: get chunk
      if (sql.includes('SELECT id, content, embedding, adhp FROM chunks')) {
        return { rows: chunk ? [chunk] : [] };
      }
      // Second call: get topic IDs
      if (sql.includes('SELECT topic_id FROM chunk_topics')) {
        return { rows: topicIds.map(id => ({ topic_id: id })) };
      }
      // Vector subscription query
      if (sql.includes('<=>') && sql.includes("s.type = 'vector'")) {
        return { rows: vectorResults };
      }
      // Keyword subscription query (now SQL ILIKE)
      if (sql.includes("type = 'keyword'") && sql.includes('ILIKE')) {
        return { rows: keywordResults };
      }
      // Topic subscription query
      if (sql.includes("type = 'topic'") && sql.includes('topic_id = ANY')) {
        return { rows: topicResults };
      }
      // ADHP filter: fetch accounts
      if (sql.includes('SELECT id, adhp FROM accounts')) {
        return { rows: [] };
      }
      return { rows: [] };
    });
  }

  describe('vector subscription matching', () => {
    it('finds vector subscriptions above similarity threshold', async () => {
      setupMocks({
        chunk: CHUNK_WITH_EMBEDDING,
        vectorResults: [
          { subscription_id: 'sub-1', account_id: 'acc-1', similarity: 0.85 },
        ],
      });

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
      setupMocks({
        chunk: { ...CHUNK_WITH_EMBEDDING, embedding: null },
      });

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
    it('matches keyword subscriptions via SQL ILIKE on content', async () => {
      setupMocks({
        chunk: { ...CHUNK_WITH_EMBEDDING, embedding: null },
        keywordResults: [
          { subscription_id: 'sub-kw1', account_id: 'acc-2', keyword: 'machine learning' },
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

    it('keyword matching uses ILIKE (SQL-side, case-insensitive)', async () => {
      setupMocks({
        chunk: { ...CHUNK_WITH_EMBEDDING, embedding: null },
        keywordResults: [
          { subscription_id: 'sub-kw1', account_id: 'acc-2', keyword: 'MACHINE LEARNING' },
        ],
      });

      const matches = await matchNewChunk(CHUNK_ID);

      expect(matches).toHaveLength(1);
      expect(matches[0].matchType).toBe('keyword');

      // Verify ILIKE is in the SQL
      const keywordCall = mockPool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('ILIKE')
      );
      expect(keywordCall).toBeTruthy();
    });
  });

  describe('topic subscription matching', () => {
    it('matches topic subscriptions for chunk topics', async () => {
      setupMocks({
        chunk: { ...CHUNK_WITH_EMBEDDING, embedding: null },
        topicIds: ['topic-1', 'topic-2'],
        topicResults: [
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
      setupMocks({
        chunk: { ...CHUNK_WITH_EMBEDDING, embedding: null },
        topicIds: [],
      });

      const matches = await matchNewChunk(CHUNK_ID);

      expect(matches).toHaveLength(0);
      // Topic subscription query should not be called
      const topicQueryCalled = mockPool.query.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.includes("type = 'topic'")
      );
      expect(topicQueryCalled).toBe(false);
    });
  });

  describe('combined matching', () => {
    it('returns matches from all three types', async () => {
      setupMocks({
        chunk: CHUNK_WITH_EMBEDDING,
        topicIds: ['topic-1'],
        vectorResults: [{ subscription_id: 'sub-v', account_id: 'acc-1', similarity: 0.9 }],
        keywordResults: [{ subscription_id: 'sub-k', account_id: 'acc-2', keyword: 'natural language' }],
        topicResults: [{ subscription_id: 'sub-t', account_id: 'acc-3', topic_id: 'topic-1' }],
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
    setupMocks({ chunk: null });

    const matches = await matchNewChunk('nonexistent');

    expect(matches).toEqual([]);
  });

  describe('deduplicateMatches', () => {
    it('removes duplicate subscriptions, keeps first', () => {
      const matches = [
        { subscriptionId: 'sub-1', accountId: 'acc-1', matchType: 'vector', similarity: 0.9 },
        { subscriptionId: 'sub-1', accountId: 'acc-1', matchType: 'keyword' },
        { subscriptionId: 'sub-2', accountId: 'acc-2', matchType: 'topic' },
      ];

      const result = deduplicateMatches(matches);

      expect(result).toHaveLength(2);
      expect(result[0].matchType).toBe('vector'); // first occurrence kept
      expect(result[1].subscriptionId).toBe('sub-2');
    });

    it('returns empty array for empty input', () => {
      expect(deduplicateMatches([])).toEqual([]);
    });
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

      mockPool.query.mockImplementation((sql) => {
        if (sql.includes('SELECT id, content, embedding, adhp FROM chunks')) {
          return { rows: [{ ...CHUNK_WITH_EMBEDDING, embedding: null, adhp: chunkAdhp }] };
        }
        if (sql.includes('SELECT topic_id FROM chunk_topics')) {
          return { rows: [] };
        }
        if (sql.includes('ILIKE')) {
          return { rows: [
            { subscription_id: 'sub-kw1', account_id: 'acc-1', keyword: 'machine learning' },
            { subscription_id: 'sub-kw2', account_id: 'acc-2', keyword: 'natural language' },
          ]};
        }
        if (sql.includes('SELECT id, adhp FROM accounts')) {
          return { rows: [
            { id: 'acc-1', adhp: { version: '0.2', sensitivity_level: 3 } },
            { id: 'acc-2', adhp: null }, // undeclared = blocked
          ]};
        }
        return { rows: [] };
      });

      const matches = await matchNewChunk(CHUNK_ID);

      expect(matches).toHaveLength(1);
      expect(matches[0].accountId).toBe('acc-1');
    });

    it('does not query accounts when chunk has no adhp (no extra query)', async () => {
      setupMocks({
        chunk: { ...CHUNK_WITH_EMBEDDING, embedding: null, adhp: null },
        keywordResults: [{ subscription_id: 'sub-kw1', account_id: 'acc-1', keyword: 'machine learning' }],
      });

      const matches = await matchNewChunk(CHUNK_ID);

      expect(matches).toHaveLength(1);
      // No ADHP account query should have been made
      const adhpQueryCalled = mockPool.query.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.includes('SELECT id, adhp FROM accounts')
      );
      expect(adhpQueryCalled).toBe(false);
    });
  });
});
