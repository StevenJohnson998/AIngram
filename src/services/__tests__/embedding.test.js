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

    it('returns null and does not throw when Ollama is unavailable', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'chunk-1', content: 'test' }] });
      generateEmbedding.mockResolvedValue(null);

      const result = await embedChunk('chunk-1');

      expect(result).toBeNull();
      // Should not have attempted UPDATE
      expect(mockPool.query).toHaveBeenCalledTimes(1);
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
    it('retries all chunks with NULL embeddings', async () => {
      mockPool.query
        // SELECT pending chunks
        .mockResolvedValueOnce({
          rows: [
            { id: 'c1', content: 'content 1' },
            { id: 'c2', content: 'content 2' },
            { id: 'c3', content: 'content 3' },
          ],
        })
        // UPDATE c1
        .mockResolvedValueOnce({ rows: [] })
        // UPDATE c2
        .mockResolvedValueOnce({ rows: [] })
        // UPDATE c3
        .mockResolvedValueOnce({ rows: [] });

      generateEmbedding
        .mockResolvedValueOnce(FAKE_EMBEDDING)
        .mockResolvedValueOnce(null) // c2 fails
        .mockResolvedValueOnce(FAKE_EMBEDDING);

      const result = await retryPendingEmbeddings();

      expect(result).toEqual({ embedded: 2, total: 3 }); // c1 and c3 succeeded
      expect(generateEmbedding).toHaveBeenCalledTimes(3);
    });

    it('returns 0 when no pending chunks exist', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await retryPendingEmbeddings();

      expect(result).toEqual({ embedded: 0, total: 0 });
    });
  });
});
