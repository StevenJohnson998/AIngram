jest.mock('../../config/database');
jest.mock('../ollama', () => ({ generateEmbedding: jest.fn() }));
jest.mock('../subscription-matcher', () => ({ matchNewChunk: jest.fn().mockResolvedValue([]) }));
jest.mock('../notification', () => ({ dispatchNotification: jest.fn() }));
jest.mock('../account', () => ({
  incrementInteractionAndUpdateTier: jest.fn().mockResolvedValue(),
}));
jest.mock('../flag', () => ({ createFlag: jest.fn() }));
jest.mock('../../config/trust', () => ({
  CHUNK_PRIOR_NEW: [1, 1],
  CHUNK_PRIOR_ESTABLISHED: [2, 1],
  CHUNK_PRIOR_ELITE: [3, 1],
  DUPLICATE_SIMILARITY_THRESHOLD: 0.95,
  VOTE_WEIGHT_NEW_ACCOUNT: 0.5,
  VOTE_WEIGHT_ESTABLISHED: 1.0,
  VOTER_REP_BASE: 0.5,
}));

const { getPool } = require('../../config/database');
const chunkService = require('../chunk');

describe('Suggestion chunks', () => {
  let mockPool;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    mockPool = {
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(mockClient),
    };
    getPool.mockReturnValue(mockPool);
  });

  describe('createSuggestion', () => {
    it('creates a suggestion chunk with category and rationale', async () => {
      const suggestion = {
        id: 'sug-1',
        content: 'We should add a cooldown period after disputes',
        chunk_type: 'suggestion',
        suggestion_category: 'governance',
        rationale: 'Too many retaliatory disputes',
        status: 'proposed',
      };

      // BEGIN
      mockClient.query.mockResolvedValueOnce({});
      // INSERT chunk
      mockClient.query.mockResolvedValueOnce({ rows: [suggestion] });
      // INSERT chunk_topics
      mockClient.query.mockResolvedValueOnce({});
      // INSERT activity_log
      mockClient.query.mockResolvedValueOnce({});
      // INSERT changesets
      mockClient.query.mockResolvedValueOnce({ rows: [{ id: 'mock-changeset-id' }] });
      // INSERT changeset_operations
      mockClient.query.mockResolvedValueOnce({});
      // COMMIT
      mockClient.query.mockResolvedValueOnce({});

      const result = await chunkService.createSuggestion({
        content: 'We should add a cooldown period after disputes',
        topicId: 'topic-1',
        createdBy: 'acc-1',
        suggestionCategory: 'governance',
        rationale: 'Too many retaliatory disputes',
        title: 'Dispute cooldown',
      });

      expect(result.chunk_type).toBe('suggestion');
      expect(result.suggestion_category).toBe('governance');

      // Verify INSERT includes chunk_type='suggestion'
      const insertCall = mockClient.query.mock.calls[1];
      expect(insertCall[0]).toContain("'suggestion'");
      expect(insertCall[1]).toContain('governance');
    });

    it('logs suggestion_proposed activity', async () => {
      mockClient.query.mockResolvedValueOnce({}); // BEGIN
      mockClient.query.mockResolvedValueOnce({ rows: [{ id: 'sug-1' }] }); // INSERT chunk
      mockClient.query.mockResolvedValueOnce({}); // INSERT chunk_topics
      mockClient.query.mockResolvedValueOnce({}); // INSERT activity_log
      mockClient.query.mockResolvedValueOnce({ rows: [{ id: 'mock-changeset-id' }] }); // INSERT changesets
      mockClient.query.mockResolvedValueOnce({}); // INSERT changeset_operations
      mockClient.query.mockResolvedValueOnce({}); // COMMIT

      await chunkService.createSuggestion({
        content: 'Improve UX',
        topicId: 'topic-1',
        createdBy: 'acc-1',
        suggestionCategory: 'ui_ux',
      });

      const activityCall = mockClient.query.mock.calls[3];
      expect(activityCall[0]).toContain('suggestion_proposed');
      expect(activityCall[1]).toContain('acc-1');
    });
  });

  describe('listSuggestions', () => {
    it('returns paginated suggestions filtered by status', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 2 }] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'sug-1', suggestion_category: 'governance', status: 'proposed' },
            { id: 'sug-2', suggestion_category: 'technical', status: 'proposed' },
          ],
        });

      const result = await chunkService.listSuggestions({ status: 'proposed', page: 1, limit: 20 });

      expect(result.data).toHaveLength(2);
      expect(result.pagination.total).toBe(2);

      // Verify query filters by chunk_type='suggestion'
      const countQuery = mockPool.query.mock.calls[0][0];
      expect(countQuery).toContain("chunk_type = 'suggestion'");
    });

    it('filters by category when provided', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 1 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'sug-1' }] });

      await chunkService.listSuggestions({ status: 'proposed', category: 'governance' });

      const countQuery = mockPool.query.mock.calls[0][0];
      expect(countQuery).toContain('suggestion_category');
    });
  });
});
