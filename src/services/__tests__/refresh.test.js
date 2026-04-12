jest.mock('../../config/database');
jest.mock('../../../build/config/protocol', () => ({
  DELTA_REFRESH_VERIFY: 0.02,
  DELTA_REFRESH_UPDATE: 0.08,
  DELTA_REFRESH_FLAG_VALID: 0.05,
  DELTA_REFRESH_FLAG_INVALID: -0.02,
}));

const { getPool } = require('../../config/database');
const refreshService = require('../refresh');

describe('Refresh service', () => {
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

  // --- flagChunk ---

  describe('flagChunk', () => {
    it('inserts a pending flag and returns it', async () => {
      const flag = { id: 'flag-1', chunk_id: 'c1', status: 'pending', reason: 'Outdated claim' };

      // Validate chunk exists + knowledge topic
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'c1', topic_type: 'knowledge' }],
      });
      // INSERT flag
      mockPool.query.mockResolvedValueOnce({ rows: [flag] });

      const result = await refreshService.flagChunk('c1', 'account-1', 'Outdated claim', null);
      expect(result).toEqual(flag);
      expect(mockPool.query).toHaveBeenCalledTimes(2);
    });

    it('throws NOT_FOUND if chunk does not exist', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      await expect(refreshService.flagChunk('bad-id', 'a1', 'reason'))
        .rejects.toThrow('Chunk not found');
    });

    it('throws VALIDATION_ERROR on non-knowledge topic', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'c1', topic_type: 'course' }],
      });
      await expect(refreshService.flagChunk('c1', 'a1', 'reason'))
        .rejects.toThrow('knowledge topics');
    });
  });

  // --- getTopicRefreshFlags ---

  describe('getTopicRefreshFlags', () => {
    it('returns flags grouped by chunk', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { chunk_id: 'c1', id: 'f1', reason: 'Old', status: 'pending', chunk_content_preview: 'Some content here' },
          { chunk_id: 'c1', id: 'f2', reason: 'Very old', status: 'pending', chunk_content_preview: 'Some content here' },
          { chunk_id: 'c2', id: 'f3', reason: 'Needs update', status: 'pending', chunk_content_preview: 'Other content' },
        ],
      });

      const result = await refreshService.getTopicRefreshFlags('topic-1');
      expect(result).toHaveLength(2); // 2 chunks
      expect(result[0].chunk_id).toBe('c1');
      expect(result[0].flags).toHaveLength(2);
      expect(result[1].chunk_id).toBe('c2');
      expect(result[1].flags).toHaveLength(1);
    });

    it('returns empty array when no pending flags', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const result = await refreshService.getTopicRefreshFlags('topic-1');
      expect(result).toEqual([]);
    });
  });

  // --- submitRefresh ---

  describe('submitRefresh', () => {
    it('rejects invalid global verdict', async () => {
      await expect(refreshService.submitRefresh('t1', 'a1', [{ chunk_id: 'c1', op: 'verify' }], 'invalid'))
        .rejects.toThrow('globalVerdict');
    });

    it('rejects empty operations', async () => {
      await expect(refreshService.submitRefresh('t1', 'a1', [], 'refreshed'))
        .rejects.toThrow('Operations array');
    });

    it('rejects invalid operation type', async () => {
      await expect(refreshService.submitRefresh('t1', 'a1', [{ chunk_id: 'c1', op: 'delete' }], 'refreshed'))
        .rejects.toThrow('Invalid operation');
    });

    it('rejects update without new_content', async () => {
      await expect(refreshService.submitRefresh('t1', 'a1', [{ chunk_id: 'c1', op: 'update' }], 'refreshed'))
        .rejects.toThrow('new_content is required');
    });

    it('rejects if topic not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // topic lookup
      await expect(refreshService.submitRefresh('t1', 'a1', [{ chunk_id: 'c1', op: 'verify' }], 'refreshed'))
        .rejects.toThrow('Topic not found');
    });

    it('rejects non-knowledge topic', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 't1', topic_type: 'course' }] });
      await expect(refreshService.submitRefresh('t1', 'a1', [{ chunk_id: 'c1', op: 'verify' }], 'refreshed'))
        .rejects.toThrow('knowledge topics');
    });

    it('rejects incomplete coverage (missing chunk)', async () => {
      // Topic exists
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 't1', topic_type: 'knowledge' }] });
      // Published chunks: c1, c2, c3
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      });

      await expect(
        refreshService.submitRefresh('t1', 'a1', [
          { chunk_id: 'c1', op: 'verify' },
          { chunk_id: 'c2', op: 'verify' },
          // c3 missing!
        ], 'refreshed')
      ).rejects.toThrow('Missing operation for chunk');
    });

    it('rejects extraneous chunk not in topic', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 't1', topic_type: 'knowledge' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'c1' }] });

      await expect(
        refreshService.submitRefresh('t1', 'a1', [
          { chunk_id: 'c1', op: 'verify' },
          { chunk_id: 'c-extraneous', op: 'verify' },
        ], 'refreshed')
      ).rejects.toThrow('not a published chunk');
    });

    it('processes a full refresh with verify + update ops', async () => {
      // Topic exists
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 't1', topic_type: 'knowledge' }] });
      // Published chunks
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'c1' }, { id: 'c2' }] });

      // Transaction queries (in order):
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'log-1' }] }) // activity_log INSERT
        .mockResolvedValueOnce({}) // chunk_verified activity_log (c1 verify)
        .mockResolvedValueOnce({}) // UPDATE chunks (c2 update)
        .mockResolvedValueOnce({}) // chunk_refresh_updated activity_log (c2 update)
        .mockResolvedValueOnce({}) // resolve pending flags
        .mockResolvedValueOnce({}) // UPDATE topics (clear to_be_refreshed)
        .mockResolvedValueOnce({}) // UPDATE accounts (reputation)
        .mockResolvedValueOnce({}); // COMMIT

      const result = await refreshService.submitRefresh('t1', 'a1', [
        { chunk_id: 'c1', op: 'verify', evidence: { verdict: 'verify' } },
        { chunk_id: 'c2', op: 'update', new_content: 'Updated text', evidence: { verdict: 'update' } },
      ], 'refreshed');

      expect(result.topicFresh).toBe(true);
      expect(result.verifyCount).toBe(1);
      expect(result.updateCount).toBe(1);
      expect(result.flagCount).toBe(0);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('keeps topic as needing refresh when flag ops are present', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 't1', topic_type: 'knowledge' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'c1' }, { id: 'c2' }] });

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'log-1' }] }) // activity_log
        .mockResolvedValueOnce({}) // c1 verify log
        .mockResolvedValueOnce({}) // c2 flag INSERT chunk_refresh_flags
        .mockResolvedValueOnce({}) // resolve flags for verify chunks
        .mockResolvedValueOnce({}) // UPDATE topics (but not clearing to_be_refreshed)
        .mockResolvedValueOnce({}) // reputation
        .mockResolvedValueOnce({}); // COMMIT

      const result = await refreshService.submitRefresh('t1', 'a1', [
        { chunk_id: 'c1', op: 'verify' },
        { chunk_id: 'c2', op: 'flag', reason: 'Needs expert review' },
      ], 'needs_more_work');

      expect(result.topicFresh).toBe(false);
      expect(result.flagCount).toBe(1);
    });

    it('rolls back on error', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 't1', topic_type: 'knowledge' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'c1' }] });

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('DB error')); // activity_log fails

      await expect(
        refreshService.submitRefresh('t1', 'a1', [{ chunk_id: 'c1', op: 'verify' }], 'refreshed')
      ).rejects.toThrow('DB error');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  // --- listRefreshQueue ---

  describe('listRefreshQueue', () => {
    it('returns topics sorted by urgency with computed scores', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 't1', title: 'Topic A', slug: 'topic-a', lang: 'en', age_factor: '1.0', flags_factor: '0.6', pending_flag_count: 2 },
          { id: 't2', title: 'Topic B', slug: 'topic-b', lang: 'en', age_factor: '0.5', flags_factor: '0', pending_flag_count: 0 },
        ],
      });

      const result = await refreshService.listRefreshQueue({ limit: 20 });
      expect(result).toHaveLength(2);
      expect(result[0].urgency_score).toBe(1.6);
      expect(result[1].urgency_score).toBe(0.5);
    });
  });

  // --- dismissFlag ---

  describe('dismissFlag', () => {
    it('dismisses a pending flag and applies negative reputation', async () => {
      const dismissedFlag = {
        id: 'f1', chunk_id: 'c1', flagged_by: 'flagger-1',
        status: 'dismissed', dismissed_by: 'policer-1',
      };

      // UPDATE flag
      mockPool.query.mockResolvedValueOnce({ rows: [dismissedFlag] });
      // UPDATE accounts reputation
      mockPool.query.mockResolvedValueOnce({});
      // Check remaining pending flags
      mockPool.query.mockResolvedValueOnce({ rows: [{ cnt: 0 }] });
      // Clear topic to_be_refreshed
      mockPool.query.mockResolvedValueOnce({});

      const result = await refreshService.dismissFlag('f1', 'policer-1', 'Flag was incorrect');
      expect(result.status).toBe('dismissed');
      // Verify reputation penalty applied
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('reputation_contribution'),
        expect.arrayContaining([-0.02, 'flagger-1'])
      );
    });

    it('throws NOT_FOUND for non-existent or resolved flag', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      await expect(refreshService.dismissFlag('bad-id', 'a1', 'reason'))
        .rejects.toThrow('Flag not found');
    });
  });

  // --- getPendingFlagCount ---

  describe('getPendingFlagCount', () => {
    it('returns count of pending flags for a topic', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ count: 3 }] });
      const count = await refreshService.getPendingFlagCount('topic-1');
      expect(count).toBe(3);
    });
  });

  // --- getPendingFlagsByChunk ---

  describe('getPendingFlagsByChunk', () => {
    it('returns flag counts grouped by chunk', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { chunk_id: 'c1', flag_count: 2 },
          { chunk_id: 'c2', flag_count: 1 },
        ],
      });
      const result = await refreshService.getPendingFlagsByChunk('topic-1');
      expect(result).toEqual({ c1: 2, c2: 1 });
    });
  });
});
