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
jest.mock('../topic', () => ({
  getTopicById: jest.fn(),
}));

const { getPool } = require('../../config/database');
const chunkService = require('../chunk');
const topicService = require('../topic');

describe('Metachunk', () => {
  let mockPool;
  let mockClient;

  const UUID1 = '550e8400-e29b-41d4-a716-446655440000';
  const UUID2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

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

  describe('createMetachunk', () => {
    const validContent = JSON.stringify({ order: [UUID1, UUID2] });

    it('creates a metachunk with valid JSON content', async () => {
      topicService.getTopicById.mockResolvedValue({
        id: 'topic-1', topic_type: 'knowledge',
      });

      const metachunk = {
        id: 'meta-1', content: validContent, chunk_type: 'meta', status: 'proposed',
      };

      // BEGIN, INSERT chunk, INSERT chunk_topics, INSERT activity_log, COMMIT
      mockClient.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [metachunk] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const result = await chunkService.createMetachunk({
        content: validContent,
        topicId: 'topic-1',
        createdBy: 'acc-1',
      });

      expect(result.chunk_type).toBe('meta');
      expect(result.status).toBe('proposed');

      // Verify INSERT includes chunk_type='meta'
      const insertCall = mockClient.query.mock.calls[1];
      expect(insertCall[0]).toContain("'meta'");
    });

    it('rejects invalid JSON content', async () => {
      topicService.getTopicById.mockResolvedValue({
        id: 'topic-1', topic_type: 'knowledge',
      });

      await expect(chunkService.createMetachunk({
        content: 'not json',
        topicId: 'topic-1',
        createdBy: 'acc-1',
      })).rejects.toThrow('valid JSON');
    });

    it('rejects empty order array', async () => {
      topicService.getTopicById.mockResolvedValue({
        id: 'topic-1', topic_type: 'knowledge',
      });

      await expect(chunkService.createMetachunk({
        content: JSON.stringify({ order: [] }),
        topicId: 'topic-1',
        createdBy: 'acc-1',
      })).rejects.toThrow('non-empty');
    });

    it('rejects non-UUID in order', async () => {
      topicService.getTopicById.mockResolvedValue({
        id: 'topic-1', topic_type: 'knowledge',
      });

      await expect(chunkService.createMetachunk({
        content: JSON.stringify({ order: ['not-a-uuid'] }),
        topicId: 'topic-1',
        createdBy: 'acc-1',
      })).rejects.toThrow('UUID');
    });

    it('rejects when topic not found', async () => {
      topicService.getTopicById.mockResolvedValue(null);

      await expect(chunkService.createMetachunk({
        content: validContent,
        topicId: 'nonexistent',
        createdBy: 'acc-1',
      })).rejects.toThrow('Topic not found');
    });

    it('rejects course sub-object on knowledge topic', async () => {
      topicService.getTopicById.mockResolvedValue({
        id: 'topic-1', topic_type: 'knowledge',
      });

      const content = JSON.stringify({
        order: [UUID1],
        course: { level: 'beginner', prerequisites: [], learningObjectives: ['Learn X'] },
      });

      await expect(chunkService.createMetachunk({
        content,
        topicId: 'topic-1',
        createdBy: 'acc-1',
      })).rejects.toThrow('only allowed for topics with topic_type=course');
    });

    it('accepts course sub-object on course topic', async () => {
      topicService.getTopicById.mockResolvedValue({
        id: 'topic-1', topic_type: 'course',
      });

      const content = JSON.stringify({
        order: [UUID1],
        course: { level: 'beginner', prerequisites: [], learningObjectives: ['Learn X'] },
      });

      const metachunk = { id: 'meta-1', content, chunk_type: 'meta', status: 'proposed' };

      mockClient.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [metachunk] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const result = await chunkService.createMetachunk({
        content,
        topicId: 'topic-1',
        createdBy: 'acc-1',
      });

      expect(result.chunk_type).toBe('meta');
    });

    it('requires course sub-object on course topic', async () => {
      topicService.getTopicById.mockResolvedValue({
        id: 'topic-1', topic_type: 'course',
      });

      await expect(chunkService.createMetachunk({
        content: JSON.stringify({ order: [UUID1] }),
        topicId: 'topic-1',
        createdBy: 'acc-1',
      })).rejects.toThrow('required for topics with topic_type=course');
    });

    it('logs metachunk_proposed activity', async () => {
      topicService.getTopicById.mockResolvedValue({
        id: 'topic-1', topic_type: 'knowledge',
      });

      mockClient.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'meta-1', chunk_type: 'meta', status: 'proposed' }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await chunkService.createMetachunk({
        content: validContent,
        topicId: 'topic-1',
        createdBy: 'acc-1',
      });

      const activityCall = mockClient.query.mock.calls[3];
      expect(activityCall[0]).toContain('metachunk_proposed');
    });
  });

  describe('getActiveMetachunk', () => {
    it('returns published metachunk for topic', async () => {
      const meta = { id: 'meta-1', chunk_type: 'meta', status: 'published', content: '{"order":[]}' };
      mockPool.query.mockResolvedValue({ rows: [meta] });

      const result = await chunkService.getActiveMetachunk('topic-1');

      expect(result).toEqual(meta);
      expect(mockPool.query.mock.calls[0][0]).toContain("chunk_type = 'meta'");
      expect(mockPool.query.mock.calls[0][0]).toContain("status = 'published'");
    });

    it('returns null when no metachunk exists', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await chunkService.getActiveMetachunk('topic-1');
      expect(result).toBeNull();
    });
  });

  describe('metachunk supersession on merge', () => {
    it('supersedes old metachunk when new one is published via mergeChunk', async () => {
      // mergeChunk flow for a meta chunk
      const proposed = {
        id: 'meta-new', status: 'proposed', chunk_type: 'meta',
        parent_chunk_id: null, vote_score: null, created_by: 'acc-1',
      };

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [proposed] }) // SELECT proposed chunk
        .mockResolvedValueOnce({ rows: [{ id: 'meta-new', status: 'published', chunk_type: 'meta' }] }) // UPDATE to published
        .mockResolvedValueOnce({ rows: [{ topic_id: 'topic-1' }] }) // SELECT topic_id from chunk_topics
        .mockResolvedValueOnce({ rows: [{ id: 'meta-old' }] }) // UPDATE old metachunk to superseded
        .mockResolvedValueOnce({}) // INSERT activity_log
        .mockResolvedValueOnce({}); // COMMIT

      const result = await chunkService.mergeChunk('meta-new', 'admin-1');

      // Verify supersession query was called
      const supersedeCall = mockClient.query.mock.calls[4];
      expect(supersedeCall[0]).toContain("status = 'superseded'");
      expect(supersedeCall[0]).toContain("chunk_type = 'meta'");
      expect(supersedeCall[1]).toContain('topic-1');
      expect(supersedeCall[1]).toContain('meta-new');
    });

    it('does not supersede for non-meta chunks', async () => {
      const proposed = {
        id: 'chunk-1', status: 'proposed', chunk_type: 'knowledge',
        parent_chunk_id: null, vote_score: null, created_by: 'acc-1',
      };

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [proposed] }) // SELECT proposed chunk
        .mockResolvedValueOnce({ rows: [{ id: 'chunk-1', status: 'published', chunk_type: 'knowledge' }] }) // UPDATE to published
        .mockResolvedValueOnce({}) // INSERT activity_log
        .mockResolvedValueOnce({}); // COMMIT

      await chunkService.mergeChunk('chunk-1', 'admin-1');

      // Should NOT have a supersession query (only 5 calls, not 7)
      expect(mockClient.query).toHaveBeenCalledTimes(5);
    });
  });
});
