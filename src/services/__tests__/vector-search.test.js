jest.mock('../../config/database');
jest.mock('../ollama');

const { getPool } = require('../../config/database');
const { generateEmbedding } = require('../ollama');
const { searchByVector, searchByText, hybridSearch, LANG_TO_PG_CONFIG, pgConfig } = require('../vector-search');

const FAKE_EMBEDDING = Array.from({ length: 1024 }, (_, i) => i * 0.001);

describe('vector-search', () => {
  let mockPool;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
    };
    getPool.mockReturnValue(mockPool);
    jest.clearAllMocks();
  });

  describe('searchByVector', () => {
    it('queries with correct pgvector SQL and parameters', async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          { id: 'c1', content: 'result 1', similarity: 0.92 },
          { id: 'c2', content: 'result 2', similarity: 0.85 },
        ],
      });

      const result = await searchByVector(FAKE_EMBEDDING, { limit: 10, minSimilarity: 0.7 });

      expect(result).toHaveLength(2);
      expect(result[0].similarity).toBe(0.92);

      const [sql, params] = mockPool.query.mock.calls[0];
      expect(sql).toContain('<=>');
      expect(sql).toContain('$1::vector');
      expect(params[0]).toMatch(/^\[/);
      expect(params[1]).toBe(0.7);
      expect(params[2]).toBe(10);
    });

    it('uses default limit and minSimilarity', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await searchByVector(FAKE_EMBEDDING);

      const [, params] = mockPool.query.mock.calls[0];
      expect(params[1]).toBe(0.5);  // default minSimilarity
      expect(params[2]).toBe(20);   // default limit
    });
  });

  describe('searchByText', () => {
    it('uses full-text search with ts_rank', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ id: 'c1', content: 'machine learning', rank: 0.8 }],
      });

      const result = await searchByText('machine learning', { limit: 5 });

      expect(result).toHaveLength(1);

      const [sql, params] = mockPool.query.mock.calls[0];
      expect(sql).toContain('to_tsvector');
      expect(sql).toContain('plainto_tsquery');
      expect(params[0]).toBe('machine learning');
      expect(params[1]).toBe(5);
    });

    it('defaults to english config when no langs provided', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await searchByText('test query');

      const [sql] = mockPool.query.mock.calls[0];
      expect(sql).toContain("'english'");
    });

    it('uses correct PG config for French', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await searchByText('apprentissage automatique', { langs: ['fr'] });

      const [sql] = mockPool.query.mock.calls[0];
      expect(sql).toContain("'french'");
    });

    it('supports bilingual search with OR condition', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await searchByText('machine learning', { langs: ['fr', 'en'] });

      const [sql] = mockPool.query.mock.calls[0];
      expect(sql).toContain("'french'");
      expect(sql).toContain("'english'");
      expect(sql).toContain('OR');
      expect(sql).toContain('GREATEST');
    });

    it('uses simple config for languages without PG support', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await searchByText('test', { langs: ['zh'] });

      const [sql] = mockPool.query.mock.calls[0];
      expect(sql).toContain("'simple'");
    });
  });

  describe('hybridSearch', () => {
    it('merges and deduplicates results with weighted scoring', async () => {
      generateEmbedding.mockResolvedValue(FAKE_EMBEDDING);

      // Vector search returns c1, c2
      // Text search returns c2, c3
      mockPool.query
        .mockResolvedValueOnce({
          rows: [
            { id: 'c1', content: 'result 1', similarity: 0.9 },
            { id: 'c2', content: 'result 2', similarity: 0.7 },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            { id: 'c2', content: 'result 2', rank: 0.8 },
            { id: 'c3', content: 'result 3', rank: 0.6 },
          ],
        });

      const result = await hybridSearch('test query', {
        limit: 10,
        vectorWeight: 0.7,
        textWeight: 0.3,
      });

      // Should have 3 unique chunks
      expect(result).toHaveLength(3);

      const ids = result.map((r) => r.id);
      expect(ids).toContain('c1');
      expect(ids).toContain('c2');
      expect(ids).toContain('c3');

      // c2 appears in both — should have highest combined score
      const c2 = result.find((r) => r.id === 'c2');
      expect(c2.score).toBeGreaterThan(0);
      expect(c2.vectorScore).toBe(0.7);
      expect(c2.textScore).toBe(0.8);
    });

    it('falls back to text-only when Ollama is down', async () => {
      generateEmbedding.mockResolvedValue(null);
      mockPool.query.mockResolvedValue({
        rows: [{ id: 'c1', content: 'text result', rank: 0.5 }],
      });

      const result = await hybridSearch('test query');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('c1');
      // Should only call text search (one query), not vector search
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });

    it('passes langs to text search in hybrid mode', async () => {
      generateEmbedding.mockResolvedValue(FAKE_EMBEDDING);
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })  // vector
        .mockResolvedValueOnce({ rows: [] }); // text

      await hybridSearch('test', { langs: ['fr', 'en'] });

      // Second call is text search — should use French + English
      const [sql] = mockPool.query.mock.calls[1];
      expect(sql).toContain("'french'");
      expect(sql).toContain("'english'");
    });
  });

  describe('LANG_TO_PG_CONFIG', () => {
    it('maps common languages to PG configs', () => {
      expect(LANG_TO_PG_CONFIG.en).toBe('english');
      expect(LANG_TO_PG_CONFIG.fr).toBe('french');
      expect(LANG_TO_PG_CONFIG.de).toBe('german');
      expect(LANG_TO_PG_CONFIG.es).toBe('spanish');
    });

    it('maps unsupported languages to simple', () => {
      expect(LANG_TO_PG_CONFIG.zh).toBe('simple');
      expect(LANG_TO_PG_CONFIG.ja).toBe('simple');
      expect(LANG_TO_PG_CONFIG.ko).toBe('simple');
      expect(LANG_TO_PG_CONFIG.ar).toBe('simple');
    });
  });

  describe('pgConfig', () => {
    it('returns correct config for known lang', () => {
      expect(pgConfig('fr')).toBe('french');
      expect(pgConfig('en')).toBe('english');
    });

    it('returns simple for unknown lang', () => {
      expect(pgConfig('xx')).toBe('simple');
    });
  });
});
