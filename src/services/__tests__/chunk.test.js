jest.mock('../../config/database');
jest.mock('../../config/trust', () => ({
  CHUNK_PRIOR_NEW: [1, 1],
  CHUNK_PRIOR_ESTABLISHED: [3, 1],
  CHUNK_PRIOR_ELITE: [5, 1],
  DUPLICATE_SIMILARITY_THRESHOLD: 0.95,
  SOURCE_BONUS_PER_SOURCE: 0.75,
  SOURCE_BONUS_CAP: 3.0,
}));
jest.mock('../ollama', () => ({
  generateEmbedding: jest.fn().mockResolvedValue(null),
}));

const { getPool } = require('../../config/database');
const chunkService = require('../chunk');

describe('chunk service', () => {
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
  });

  describe('createChunk', () => {
    it('creates chunk and links to topic in a transaction', async () => {
      const chunk = {
        id: 'chunk-1',
        content: 'Test content for a chunk',
        technical_detail: null,
        has_technical_detail: false,
        created_by: 'account-1',
      };

      mockClient.query
        .mockResolvedValueOnce() // BEGIN
        .mockResolvedValueOnce({ rows: [chunk] }) // INSERT chunk
        .mockResolvedValueOnce() // INSERT chunk_topics
        .mockResolvedValueOnce(); // COMMIT

      const result = await chunkService.createChunk({
        content: 'Test content for a chunk',
        topicId: 'topic-1',
        createdBy: 'account-1',
      });

      expect(result).toEqual(chunk);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO chunks'),
        ['Test content for a chunk', null, false, 'account-1', 0.5, null, null, null]
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO chunk_topics'),
        ['chunk-1', 'topic-1']
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('sets has_technical_detail when technicalDetail provided', async () => {
      const chunk = { id: 'chunk-1', has_technical_detail: true };

      mockClient.query
        .mockResolvedValueOnce() // BEGIN
        .mockResolvedValueOnce({ rows: [chunk] })
        .mockResolvedValueOnce()
        .mockResolvedValueOnce();

      await chunkService.createChunk({
        content: 'Some test content here',
        technicalDetail: 'Benchmark data: 95% accuracy',
        topicId: 'topic-1',
        createdBy: 'account-1',
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO chunks'),
        ['Some test content here', 'Benchmark data: 95% accuracy', true, 'account-1', 0.5, null, null, null]
      );
    });

    it('rolls back on error', async () => {
      mockClient.query
        .mockResolvedValueOnce() // BEGIN
        .mockRejectedValueOnce(new Error('DB error'));

      await expect(
        chunkService.createChunk({
          content: 'Content text here',
          topicId: 'topic-1',
          createdBy: 'account-1',
        })
      ).rejects.toThrow('DB error');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('getChunkById', () => {
    it('returns chunk with sources', async () => {
      const chunk = {
        id: 'chunk-1',
        content: 'Test content',
        sources: [{ id: 'src-1', source_url: 'https://example.com' }],
      };
      mockPool.query.mockResolvedValue({ rows: [chunk] });

      const result = await chunkService.getChunkById('chunk-1');
      expect(result).toEqual(chunk);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('LEFT JOIN chunk_sources'),
        ['chunk-1']
      );
    });

    it('returns null when not found', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await chunkService.getChunkById('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('updateChunk', () => {
    it('updates content', async () => {
      const updated = { id: 'chunk-1', content: 'Updated content' };
      mockPool.query.mockResolvedValue({ rows: [updated] });

      const result = await chunkService.updateChunk('chunk-1', { content: 'Updated content' });
      expect(result.content).toBe('Updated content');
    });

    it('updates technicalDetail and has_technical_detail flag', async () => {
      const updated = { id: 'chunk-1', technical_detail: 'New detail', has_technical_detail: true };
      mockPool.query.mockResolvedValue({ rows: [updated] });

      await chunkService.updateChunk('chunk-1', { technicalDetail: 'New detail' });

      // Verify the query includes has_technical_detail = true
      const call = mockPool.query.mock.calls[0];
      expect(call[0]).toContain('has_technical_detail');
      expect(call[1]).toContain('New detail');
      expect(call[1]).toContain(true);
    });

    it('sets has_technical_detail to false when technicalDetail is null', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ id: 'chunk-1' }] });

      await chunkService.updateChunk('chunk-1', { technicalDetail: null });

      const call = mockPool.query.mock.calls[0];
      expect(call[1]).toContain(false);
    });

    it('returns null when not found', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await chunkService.updateChunk('nonexistent', { content: 'X' });
      expect(result).toBeNull();
    });
  });

  describe('retractChunk', () => {
    it('sets status to retracted', async () => {
      const retracted = { id: 'chunk-1', status: 'retracted' };
      mockPool.query.mockResolvedValue({ rows: [retracted] });

      const result = await chunkService.retractChunk('chunk-1');
      expect(result.status).toBe('retracted');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'retracted'"),
        ['chunk-1']
      );
    });

    it('returns null when not found', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await chunkService.retractChunk('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('addSource', () => {
    it('inserts a source for a chunk', async () => {
      const source = {
        id: 'src-1',
        chunk_id: 'chunk-1',
        source_url: 'https://example.com',
        source_description: 'A reference',
        added_by: 'account-1',
      };
      mockPool.query.mockResolvedValue({ rows: [source] });

      const result = await chunkService.addSource('chunk-1', {
        sourceUrl: 'https://example.com',
        sourceDescription: 'A reference',
        addedBy: 'account-1',
      });

      expect(result).toEqual(source);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO chunk_sources'),
        ['chunk-1', 'https://example.com', 'A reference', 'account-1']
      );
    });
  });

  describe('getChunksByTopic', () => {
    it('returns paginated chunks for a topic', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 30 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'c1' }, { id: 'c2' }] });

      const result = await chunkService.getChunksByTopic('topic-1', {
        status: 'active',
        page: 1,
        limit: 20,
      });

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 30 });
    });

    it('defaults to active status', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 0 }] })
        .mockResolvedValueOnce({ rows: [] });

      await chunkService.getChunksByTopic('topic-1');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['topic-1', 'active']
      );
    });
  });
});
