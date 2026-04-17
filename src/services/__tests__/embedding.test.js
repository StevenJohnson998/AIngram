jest.mock('../../config/database');
jest.mock('../ollama');

const { getPool } = require('../../config/database');
const { generateEmbedding } = require('../ollama');
const { embedChunk, embedChunkContent, retryPendingEmbeddings } = require('../embedding');

const FAKE_EMBEDDING = Array.from({ length: 1024 }, (_, i) => i * 0.001);

describe('embedding', () => {
  let mockPool;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
    };
    getPool.mockReturnValue(mockPool);
    jest.clearAllMocks();
  });

  describe('embedChunk', () => {
    it('generates and stores embedding for a chunk', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'chunk-1', content: 'test content' }] })
        .mockResolvedValueOnce({ rows: [] });
      generateEmbedding.mockResolvedValue(FAKE_EMBEDDING);

      const result = await embedChunk('chunk-1');

      expect(result).toEqual(FAKE_EMBEDDING);
      // Verify SELECT used content field
      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT id, content FROM chunks WHERE id = $1',
        ['chunk-1']
      );
      // Verify embedding was stored
      expect(mockPool.query).toHaveBeenCalledWith(
        'UPDATE chunks SET embedding = $1::vector WHERE id = $2',
        [expect.stringContaining('['), 'chunk-1']
      );
      // Verify generateEmbedding was called with content (not technical_detail)
      expect(generateEmbedding).toHaveBeenCalledWith('test content');
    });

    it('returns null and tracks failure when Ollama is unavailable', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'chunk-1', content: 'test' }] })
        .mockResolvedValueOnce({ rows: [] });
      generateEmbedding.mockResolvedValue(null);

      const result = await embedChunk('chunk-1');

      expect(result).toBeNull();
      expect(mockPool.query).toHaveBeenCalledTimes(2);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('embedding_attempts'),
        expect.arrayContaining(['chunk-1'])
      );
    });

    it('returns null when chunk not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await embedChunk('nonexistent');

      expect(result).toBeNull();
      expect(generateEmbedding).not.toHaveBeenCalled();
    });
  });

  describe('embedChunkContent', () => {
    it('delegates to generateEmbedding', async () => {
      generateEmbedding.mockResolvedValue(FAKE_EMBEDDING);

      const result = await embedChunkContent('search query');

      expect(result).toEqual(FAKE_EMBEDDING);
      expect(generateEmbedding).toHaveBeenCalledWith('search query');
    });
  });

  describe('retryPendingEmbeddings', () => {
    it('retries chunks and tracks failures', async () => {
      mockPool.query
        // SELECT pending chunks
        .mockResolvedValueOnce({
          rows: [
            { id: 'c1', content: 'content 1', embedding_attempts: 0 },
            { id: 'c2', content: 'content 2', embedding_attempts: 0 },
            { id: 'c3', content: 'content 3', embedding_attempts: 0 },
          ],
        })
        // UPDATE c1 (success)
        .mockResolvedValueOnce({ rows: [] })
        // UPDATE c2 (failure tracking)
        .mockResolvedValueOnce({ rows: [] })
        // UPDATE c3 (success)
        .mockResolvedValueOnce({ rows: [] });

      generateEmbedding
        .mockResolvedValueOnce(FAKE_EMBEDDING)
        .mockResolvedValueOnce(null) // c2 fails
        .mockResolvedValueOnce(FAKE_EMBEDDING);

      const result = await retryPendingEmbeddings();

      expect(result).toEqual({ embedded: 2, failed: 1, total: 3 });
      expect(generateEmbedding).toHaveBeenCalledTimes(3);
      // c2 failure should increment attempts
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('embedding_attempts'),
        expect.arrayContaining(['c2'])
      );
    });

    it('returns zeros when no pending chunks exist', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await retryPendingEmbeddings();

      expect(result).toEqual({ embedded: 0, failed: 0, total: 0 });
    });
  });
});
