jest.mock('../../config/database');

const { getPool } = require('../../config/database');
const relatedService = require('../related');

describe('related service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('relatedByChunkEmbedding', () => {
    it('returns cross-topic chunks ranked by similarity', async () => {
      const mockRows = [
        { chunk_id: 'c1', content: 'Trust scoring methods', chunk_title: null, topic_id: 't2', topic_title: 'Trust Scoring', topic_slug: 'trust-scoring', similarity: 0.87 },
        { chunk_id: 'c2', content: 'Reputation systems', chunk_title: null, topic_id: 't3', topic_title: 'Reputation', topic_slug: 'reputation', similarity: 0.72 },
      ];
      mockPool.query.mockResolvedValueOnce({ rows: mockRows });

      const results = await relatedService.relatedByChunkEmbedding('t1', 5);

      expect(results).toHaveLength(2);
      expect(results[0].similarity).toBe(0.87);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('ct.topic_id != $1'),
        expect.arrayContaining(['t1'])
      );
    });

    it('respects limit cap', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await relatedService.relatedByChunkEmbedding('t1', 999);

      // Should cap at RELATED_MAX * 2 (over-fetch for merge)
      const args = mockPool.query.mock.calls[0][1];
      expect(args[2]).toBeLessThanOrEqual(20);
    });

    it('returns empty array when no matches', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const results = await relatedService.relatedByChunkEmbedding('t1', 5);
      expect(results).toEqual([]);
    });
  });

  describe('relatedByTopicEmbedding', () => {
    it('returns topics ranked by centroid similarity', async () => {
      const mockRows = [
        { topic_id: 't2', topic_title: 'Knowledge Governance', topic_slug: 'knowledge-governance', similarity: 0.91 },
      ];
      mockPool.query.mockResolvedValueOnce({ rows: mockRows });

      const results = await relatedService.relatedByTopicEmbedding('t1', 5);

      expect(results).toHaveLength(1);
      expect(results[0].topic_id).toBe('t2');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('AVG(c.embedding)'),
        expect.arrayContaining(['t1'])
      );
    });
  });

  describe('relatedChunks', () => {
    it('returns related chunks from other topics', async () => {
      const mockRows = [
        { chunk_id: 'c5', content: 'Transformer architecture', chunk_title: 'Transformers', topic_id: 't3', topic_title: 'LLMs', topic_slug: 'llms', similarity: 0.93 },
      ];
      mockPool.query.mockResolvedValueOnce({ rows: mockRows });

      const results = await relatedService.relatedChunks('c1', 5);

      expect(results).toHaveLength(1);
      expect(results[0].chunk_id).toBe('c5');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('c2.id != c1.id'),
        expect.arrayContaining(['c1'])
      );
    });
  });

  describe('getRelatedTopics', () => {
    it('merges chunk and topic signals, deduplicates by topic, sorts by score', async () => {
      // Chunk embedding signal: t2 at 0.85, t3 at 0.72
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { topic_id: 't2', topic_title: 'Trust', topic_slug: 'trust', content: 'Trust methods...', similarity: '0.85' },
          { topic_id: 't3', topic_title: 'Reputation', topic_slug: 'reputation', content: 'Rep systems...', similarity: '0.72' },
        ],
      });
      // Topic embedding signal: t2 at 0.91 (higher), t4 at 0.65
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { topic_id: 't2', topic_title: 'Trust', topic_slug: 'trust', similarity: '0.91' },
          { topic_id: 't4', topic_title: 'Governance', topic_slug: 'governance', similarity: '0.65' },
        ],
      });

      const results = await relatedService.getRelatedTopics('t1');

      // t2 should appear once with highest score (0.91 from topic signal)
      expect(results.length).toBeLessThanOrEqual(5);
      expect(results[0].topicId).toBe('t2');
      expect(results[0].score).toBe(0.91);
      expect(results[0].signal).toBe('topic_embedding');

      // t3 from chunk signal
      const t3 = results.find(r => r.topicId === 't3');
      expect(t3).toBeDefined();
      expect(t3.signal).toBe('chunk_embedding');

      // t4 from topic signal
      const t4 = results.find(r => r.topicId === 't4');
      expect(t4).toBeDefined();

      // Sorted desc by score
      for (let i = 1; i < results.length; i++) {
        expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
      }
    });

    it('returns empty array when no related content', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const results = await relatedService.getRelatedTopics('t1');
      expect(results).toEqual([]);
    });

    it('includes chunk excerpt in results', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { topic_id: 't2', topic_title: 'Trust', topic_slug: 'trust', content: 'A'.repeat(300), similarity: '0.85' },
        ],
      });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const results = await relatedService.getRelatedTopics('t1');
      expect(results[0].chunkExcerpt.length).toBeLessThanOrEqual(200);
    });
  });
});
