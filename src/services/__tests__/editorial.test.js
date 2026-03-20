jest.mock('../../config/database');
jest.mock('../../config/editorial', () => ({
  MERGE_TIMEOUT_LOW_SENSITIVITY_MS: 60000,
  MERGE_TIMEOUT_HIGH_SENSITIVITY_MS: 120000,
  AUTO_MERGE_CHECK_INTERVAL_MS: 5000,
}));
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

describe('editorial model', () => {
  let mockPool, mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn(), connect: jest.fn() };
    mockClient = { query: jest.fn(), release: jest.fn() };
    mockPool.connect.mockResolvedValue(mockClient);
    getPool.mockReturnValue(mockPool);
  });

  describe('proposeEdit', () => {
    it('creates proposed chunk linked to original', async () => {
      // Get original version
      mockClient.query.mockResolvedValueOnce({}); // BEGIN
      mockClient.query.mockResolvedValueOnce({ rows: [{ version: 1 }] });
      // INSERT proposed chunk
      mockClient.query.mockResolvedValueOnce({
        rows: [{
          id: 'proposed-1', content: 'Updated content', status: 'proposed',
          version: 2, parent_chunk_id: 'chunk-1', proposed_by: 'user-1',
        }],
      });
      // INSERT chunk_topics
      mockClient.query.mockResolvedValueOnce({});
      // COMMIT
      mockClient.query.mockResolvedValueOnce({});

      const result = await chunkService.proposeEdit({
        originalChunkId: 'chunk-1',
        content: 'Updated content',
        proposedBy: 'user-1',
        topicId: 'topic-1',
      });

      expect(result.status).toBe('proposed');
      expect(result.version).toBe(2);
      expect(result.parent_chunk_id).toBe('chunk-1');
    });

    it('sets trust 0.833 for elite contributors', async () => {
      mockClient.query.mockResolvedValueOnce({}); // BEGIN
      mockClient.query.mockResolvedValueOnce({ rows: [{ version: 1 }] });
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: 'proposed-1', trust_score: 5/6 }],
      });
      mockClient.query.mockResolvedValueOnce({}); // chunk_topics
      mockClient.query.mockResolvedValueOnce({}); // COMMIT

      const result = await chunkService.proposeEdit({
        originalChunkId: 'chunk-1',
        content: 'Elite edit content for testing',
        proposedBy: 'elite-1',
        topicId: 'topic-1',
        isElite: true,
      });

      // Verify the INSERT query used 0.3 for trust_score
      const insertCall = mockClient.query.mock.calls[2];
      expect(insertCall[1]).toContain(5/6);
    });

    it('throws NOT_FOUND if original chunk missing', async () => {
      mockClient.query.mockResolvedValueOnce({}); // BEGIN
      mockClient.query.mockResolvedValueOnce({ rows: [] }); // no original

      await expect(
        chunkService.proposeEdit({
          originalChunkId: 'nonexistent',
          content: 'Edit content that is long enough',
          proposedBy: 'user-1',
          topicId: 'topic-1',
        })
      ).rejects.toThrow('Original chunk not found');
    });
  });

  describe('mergeChunk', () => {
    it('supersedes original and activates proposed', async () => {
      mockClient.query.mockResolvedValueOnce({}); // BEGIN
      // Get proposed chunk
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: 'proposed-1', status: 'proposed', parent_chunk_id: 'original-1' }],
      });
      // Supersede original
      mockClient.query.mockResolvedValueOnce({ rowCount: 1 });
      // Activate proposed
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: 'proposed-1', status: 'active', merged_by: 'mod-1' }],
      });
      mockClient.query.mockResolvedValueOnce({}); // COMMIT

      const result = await chunkService.mergeChunk('proposed-1', 'mod-1');

      expect(result.status).toBe('active');
      expect(result.merged_by).toBe('mod-1');
    });

    it('throws NOT_FOUND if chunk not proposed', async () => {
      mockClient.query.mockResolvedValueOnce({}); // BEGIN
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        chunkService.mergeChunk('nonexistent', 'mod-1')
      ).rejects.toThrow('Proposed chunk not found');
    });
  });

  describe('rejectChunk', () => {
    it('sets proposed chunk to retracted', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'proposed-1', status: 'retracted' }],
      });

      const result = await chunkService.rejectChunk('proposed-1');
      expect(result.status).toBe('retracted');
    });

    it('throws NOT_FOUND if not proposed', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        chunkService.rejectChunk('nonexistent')
      ).rejects.toThrow('Proposed chunk not found');
    });
  });

  describe('getTopicHistory', () => {
    it('returns paginated history', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 5 }] })
        .mockResolvedValueOnce({
          rows: [
            {
              chunkId: 'c-1', version: 2, status: 'active', parentChunkId: 'c-0',
              content: 'v2 content', trust_score: 0.5,
              proposed_by: 'user-1', proposed_by_name: 'Agent1',
              merged_by: 'mod-1', merged_by_name: 'Moderator',
              mergedAt: '2026-03-18T01:00:00Z', createdAt: '2026-03-18T00:30:00Z',
            },
          ],
        });

      const result = await chunkService.getTopicHistory('topic-1', { page: 1, limit: 20 });

      expect(result.pagination.total).toBe(5);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].version).toBe(2);
      expect(result.data[0].proposedBy.name).toBe('Agent1');
      expect(result.data[0].mergedBy.name).toBe('Moderator');
    });
  });

  describe('listPendingProposals', () => {
    it('returns proposed chunks', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 2 }] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'p-1', status: 'proposed', proposed_by_name: 'Bot' },
            { id: 'p-2', status: 'proposed', proposed_by_name: 'Agent' },
          ],
        });

      const result = await chunkService.listPendingProposals();
      expect(result.data).toHaveLength(2);
      expect(result.pagination.total).toBe(2);
    });
  });

  describe('createChunk with elite trust', () => {
    it('creates chunk with trust 0.833 for elite', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'chunk-1', trust_score: 5/6 }] })
        .mockResolvedValueOnce({}) // chunk_topics
        .mockResolvedValueOnce({}); // COMMIT

      await chunkService.createChunk({
        content: 'Elite content that is long enough',
        topicId: 'topic-1',
        createdBy: 'elite-1',
        isElite: true,
      });

      const insertCall = mockClient.query.mock.calls[1];
      expect(insertCall[1]).toContain(5/6); // elite trust = 5/(5+1)
    });

    it('creates chunk with trust 0.5 for non-elite', async () => {
      mockClient.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'chunk-1', trust_score: 0 }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await chunkService.createChunk({
        content: 'Regular content that is long enough',
        topicId: 'topic-1',
        createdBy: 'user-1',
      });

      const insertCall = mockClient.query.mock.calls[1];
      expect(insertCall[1]).toContain(0.5); // new contributor trust = 1/(1+1)
    });
  });
});
