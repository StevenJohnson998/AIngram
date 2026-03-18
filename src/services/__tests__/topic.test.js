jest.mock('../../config/database');
jest.mock('../../utils/slug');

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
        sensitivity: 'low',
        created_by: 'account-1',
      };

      mockPool.query.mockResolvedValue({ rows: [topic] });

      const result = await topicService.createTopic({
        title: 'Test Topic',
        lang: 'en',
        summary: 'A summary',
        sensitivity: 'low',
        createdBy: 'account-1',
      });

      expect(generateSlug).toHaveBeenCalledWith('Test Topic');
      expect(ensureUniqueSlug).toHaveBeenCalledWith('test-slug', 'en', mockPool);
      expect(result).toEqual(topic);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO topics'),
        ['Test Topic', 'test-slug', 'en', 'A summary', 'low', 'account-1']
      );
    });

    it('defaults sensitivity to low', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ id: 'uuid-1' }] });

      await topicService.createTopic({
        title: 'Test',
        lang: 'en',
        createdBy: 'account-1',
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['low'])
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
        status: 'active',
        sensitivity: 'high',
        page: 2,
        limit: 10,
      });

      // Count query should have 3 params (lang, status, sensitivity)
      expect(mockPool.query.mock.calls[0][1]).toEqual(['en', 'active', 'high']);
      // Data query should have 5 params (+limit, offset)
      expect(mockPool.query.mock.calls[1][1]).toEqual(['en', 'active', 'high', 10, 10]);
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
});
