jest.mock('../../config/database');
jest.mock('../../utils/slug');
jest.mock('../chunk', () => ({
  _insertChunkInTx: jest.fn(),
}));
jest.mock('../../config/trust', () => ({
  CHUNK_PRIOR_NEW: [1, 1],
  CHUNK_PRIOR_ESTABLISHED: [3, 1],
  CHUNK_PRIOR_ELITE: [5, 1],
}));
jest.mock('../injection-detector', () => ({
  analyzeContent: jest.fn().mockReturnValue({ score: 0, flags: [], suspicious: false }),
}));
jest.mock('../account', () => ({
  incrementInteractionAndUpdateTier: jest.fn().mockResolvedValue(0),
}));
jest.mock('../subscription-matcher', () => ({
  matchNewChunk: jest.fn().mockResolvedValue([]),
}));
jest.mock('../notification', () => ({
  dispatchNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../ollama', () => ({
  generateEmbedding: jest.fn().mockResolvedValue(null),
}));

const { getPool } = require('../../config/database');
const { generateSlug, ensureUniqueSlug } = require('../../utils/slug');
const topicService = require('../topic');

describe('topic service', () => {
  let mockPool;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPool = {
      query: jest.fn(),
      connect: jest.fn(),
    };

    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };

    mockPool.connect.mockResolvedValue(mockClient);
    getPool.mockReturnValue(mockPool);

    generateSlug.mockReturnValue('test-slug');
    ensureUniqueSlug.mockResolvedValue('test-slug');
  });

  describe('createTopic', () => {
    it('creates a topic with generated slug', async () => {
      const topic = {
        id: 'uuid-1',
        title: 'Test Topic',
        slug: 'test-slug',
        lang: 'en',
        summary: 'A summary',
        sensitivity: 'standard',
        created_by: 'account-1',
      };

      mockPool.query
        .mockResolvedValueOnce({ rows: [] }) // duplicate check (no match)
        .mockResolvedValueOnce({ rows: [topic] }); // INSERT

      const result = await topicService.createTopic({
        title: 'Test Topic',
        lang: 'en',
        summary: 'A summary',
        sensitivity: 'standard',
        createdBy: 'account-1',
      });

      expect(generateSlug).toHaveBeenCalledWith('Test Topic');
      expect(ensureUniqueSlug).toHaveBeenCalledWith('test-slug', 'en', mockPool);
      expect(result).toEqual(topic);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO topics'),
        ['Test Topic', 'test-slug', 'en', 'A summary', 'standard', 'knowledge', 'account-1', null]
      );
    });

    it('defaults sensitivity to standard', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] }) // duplicate check
        .mockResolvedValueOnce({ rows: [{ id: 'uuid-1' }] }); // INSERT

      await topicService.createTopic({
        title: 'Test',
        lang: 'en',
        createdBy: 'account-1',
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['standard', 'knowledge'])
      );
    });

    it('accepts topicType=course', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] }) // duplicate check
        .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', topic_type: 'course' }] });

      const result = await topicService.createTopic({
        title: 'Intro to AI',
        lang: 'en',
        topicType: 'course',
        createdBy: 'account-1',
      });

      expect(result.topic_type).toBe('course');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO topics'),
        expect.arrayContaining(['course'])
      );
    });
  });

  describe('getTopicById', () => {
    it('returns topic with chunk count', async () => {
      const topic = { id: 'uuid-1', title: 'Test', chunk_count: 5 };
      mockPool.query.mockResolvedValue({ rows: [topic] });

      const result = await topicService.getTopicById('uuid-1');
      expect(result).toEqual(topic);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('chunk_count'),
        ['uuid-1']
      );
    });

    it('returns null when not found', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await topicService.getTopicById('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getTopicBySlug', () => {
    it('finds topic by slug and lang', async () => {
      const topic = { id: 'uuid-1', slug: 'test', lang: 'en' };
      mockPool.query.mockResolvedValue({ rows: [topic] });

      const result = await topicService.getTopicBySlug('test', 'en');
      expect(result).toEqual(topic);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['test', 'en']
      );
    });
  });

  describe('listTopics', () => {
    it('returns paginated results with no filters', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 50 }] })
        .mockResolvedValueOnce({ rows: [{ id: '1' }, { id: '2' }] });

      const result = await topicService.listTopics({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 50 });
    });

    it('applies lang filter', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 10 }] })
        .mockResolvedValueOnce({ rows: [] });

      await topicService.listTopics({ lang: 'fr', page: 1, limit: 20 });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('t.lang'),
        ['fr']
      );
    });

    it('applies all filters together', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 5 }] })
        .mockResolvedValueOnce({ rows: [] });

      await topicService.listTopics({
        lang: 'en',
        status: 'published',
        sensitivity: 'sensitive',
        page: 2,
        limit: 10,
      });

      // Count query should have 3 params (lang, status, sensitivity)
      expect(mockPool.query.mock.calls[0][1]).toEqual(['en', 'published', 'sensitive']);
      // Data query should have 5 params (+limit, offset)
      expect(mockPool.query.mock.calls[1][1]).toEqual(['en', 'published', 'sensitive', 10, 10]);
    });

    it('filters by topicType', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 3 }] })
        .mockResolvedValueOnce({ rows: [{ id: '1', topic_type: 'course' }] });

      const result = await topicService.listTopics({ topicType: 'course', page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(mockPool.query.mock.calls[0][1]).toEqual(['course']);
    });
  });

  describe('updateTopic', () => {
    it('updates and regenerates slug when title changes', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', title: 'Old', slug: 'old', lang: 'en' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', title: 'New', slug: 'new' }] });

      generateSlug.mockReturnValue('new');
      ensureUniqueSlug.mockResolvedValue('new');

      const result = await topicService.updateTopic('uuid-1', { title: 'New' });

      expect(generateSlug).toHaveBeenCalledWith('New');
      expect(result.title).toBe('New');
    });

    it('keeps slug when title unchanged', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', title: 'Same', slug: 'same', lang: 'en' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', title: 'Same', slug: 'same', summary: 'Updated' }] });

      const result = await topicService.updateTopic('uuid-1', { summary: 'Updated' });
      expect(result.summary).toBe('Updated');
    });

    it('returns null when topic not found', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await topicService.updateTopic('nonexistent', { title: 'X' });
      expect(result).toBeNull();
    });

    it('rejects topic_type change (immutable)', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', title: 'Test', slug: 'test', lang: 'en', topic_type: 'knowledge' }],
      });

      await expect(
        topicService.updateTopic('uuid-1', { topicType: 'course' })
      ).rejects.toThrow('topic_type is immutable after creation');
    });

    it('allows update when topicType matches existing', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', title: 'Test', slug: 'test', lang: 'en', topic_type: 'course' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', title: 'Test', topic_type: 'course' }] });

      const result = await topicService.updateTopic('uuid-1', { topicType: 'course', summary: 'Updated' });
      expect(result).toBeTruthy();
    });
  });

  describe('flagTopic', () => {
    it('sets content flag fields', async () => {
      const flagged = {
        id: 'uuid-1',
        content_flag: 'spam',
        content_flag_reason: 'Looks like spam',
        content_flagged_by: 'account-2',
      };
      mockPool.query.mockResolvedValue({ rows: [flagged] });

      const result = await topicService.flagTopic('uuid-1', {
        contentFlag: 'spam',
        reason: 'Looks like spam',
        flaggedBy: 'account-2',
      });

      expect(result.content_flag).toBe('spam');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('content_flag'),
        ['spam', 'Looks like spam', 'account-2', 'uuid-1']
      );
    });

    it('returns null when topic not found', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await topicService.flagTopic('nonexistent', {
        contentFlag: 'spam',
        reason: 'test',
        flaggedBy: 'account-1',
      });
      expect(result).toBeNull();
    });
  });

  describe('getTranslations', () => {
    it('returns linked translations', async () => {
      const translations = [
        { id: 'uuid-2', title: 'Sujet Test', lang: 'fr' },
      ];
      mockPool.query.mockResolvedValue({ rows: translations });

      const result = await topicService.getTranslations('uuid-1');
      expect(result).toEqual(translations);
    });
  });

  describe('linkTranslation', () => {
    it('inserts bidirectional links in a transaction', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      await topicService.linkTranslation('uuid-1', 'uuid-2');

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO topic_translations'),
        ['uuid-1', 'uuid-2']
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO topic_translations'),
        ['uuid-2', 'uuid-1']
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('rolls back on error', async () => {
      mockClient.query
        .mockResolvedValueOnce() // BEGIN
        .mockRejectedValueOnce(new Error('DB error'));

      await expect(topicService.linkTranslation('uuid-1', 'uuid-2')).rejects.toThrow('DB error');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('createTopicFull', () => {
    const chunkService = require('../chunk');

    it('creates topic + chunks atomically', async () => {
      const topic = { id: 'topic-1', title: 'Test Topic', slug: 'test-slug', lang: 'en' };
      const chunk1 = { id: 'chunk-1', status: 'proposed' };
      const chunk2 = { id: 'chunk-2', status: 'proposed' };

      mockClient.query
        .mockResolvedValueOnce() // BEGIN
        .mockResolvedValueOnce({ rows: [topic] }) // INSERT topic
        .mockResolvedValueOnce() // INSERT chunk_sources for chunk 1
        .mockResolvedValueOnce({ rows: [{ id: 'mock-changeset-id' }] }) // INSERT changesets
        .mockResolvedValueOnce() // INSERT changeset_operations for chunk 1
        .mockResolvedValueOnce() // INSERT changeset_operations for chunk 2
        .mockResolvedValueOnce() // activity_log for bulk
        .mockResolvedValueOnce(); // COMMIT

      chunkService._insertChunkInTx
        .mockResolvedValueOnce(chunk1)
        .mockResolvedValueOnce(chunk2);

      const result = await topicService.createTopicFull({
        title: 'Test Topic',
        lang: 'en',
        summary: 'A test topic',
        createdBy: 'account-1',
        chunks: [
          { content: 'First chunk content here', sources: [{ sourceUrl: 'https://example.com' }] },
          { content: 'Second chunk content here' },
        ],
      });

      expect(result.topic).toEqual(topic);
      expect(result.chunks).toEqual([
        { id: 'chunk-1', status: 'proposed', injectionResult: { score: 0, flags: [], suspicious: false } },
        { id: 'chunk-2', status: 'proposed', injectionResult: { score: 0, flags: [], suspicious: false } },
      ]);
      expect(chunkService._insertChunkInTx).toHaveBeenCalledTimes(2);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('rolls back on chunk insertion failure', async () => {
      const topic = { id: 'topic-1', title: 'Test', slug: 'test-slug', lang: 'en' };

      mockClient.query
        .mockResolvedValueOnce() // BEGIN
        .mockResolvedValueOnce({ rows: [topic] }); // INSERT topic

      chunkService._insertChunkInTx
        .mockRejectedValueOnce(new Error('Chunk insert failed'));

      await expect(
        topicService.createTopicFull({
          title: 'Test',
          lang: 'en',
          createdBy: 'account-1',
          chunks: [{ content: 'Content that will fail' }],
        })
      ).rejects.toThrow('Chunk insert failed');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
