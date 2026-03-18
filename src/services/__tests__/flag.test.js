jest.mock('../../config/database');

const { getPool } = require('../../config/database');
const flagService = require('../flag');

describe('flag service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('createFlag', () => {
    it('inserts a flag with correct parameters', async () => {
      const flag = { id: 'flag-1', reporter_id: 'acc-1', target_type: 'message', target_id: 'msg-1', reason: 'spam', detection_type: 'manual', status: 'open' };
      mockPool.query.mockResolvedValue({ rows: [flag] });

      const result = await flagService.createFlag({
        reporterId: 'acc-1',
        targetType: 'message',
        targetId: 'msg-1',
        reason: 'spam',
      });

      expect(result).toEqual(flag);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO flags'),
        ['acc-1', 'message', 'msg-1', 'spam', 'manual']
      );
    });

    it('accepts custom detection type', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ id: 'flag-2', detection_type: 'temporal_burst' }] });

      await flagService.createFlag({
        reporterId: 'acc-1',
        targetType: 'account',
        targetId: 'acc-2',
        reason: 'burst detected',
        detectionType: 'temporal_burst',
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO flags'),
        ['acc-1', 'account', 'acc-2', 'burst detected', 'temporal_burst']
      );
    });

    it('rejects invalid target type', async () => {
      await expect(
        flagService.createFlag({
          reporterId: 'acc-1',
          targetType: 'invalid',
          targetId: 'x',
          reason: 'test',
        })
      ).rejects.toThrow('Invalid target_type: invalid');
    });

    it('rejects invalid detection type', async () => {
      await expect(
        flagService.createFlag({
          reporterId: 'acc-1',
          targetType: 'message',
          targetId: 'msg-1',
          reason: 'test',
          detectionType: 'bad_type',
        })
      ).rejects.toThrow('Invalid detection_type: bad_type');
    });

    it('rejects empty reason', async () => {
      await expect(
        flagService.createFlag({
          reporterId: 'acc-1',
          targetType: 'message',
          targetId: 'msg-1',
          reason: '',
        })
      ).rejects.toThrow('reason is required');
    });

    it('trims reason whitespace', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ id: 'flag-3' }] });

      await flagService.createFlag({
        reporterId: 'acc-1',
        targetType: 'message',
        targetId: 'msg-1',
        reason: '  spam content  ',
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['spam content'])
      );
    });
  });

  describe('listFlags', () => {
    it('returns paginated results filtered by status', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 5 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'f1' }, { id: 'f2' }] });

      const result = await flagService.listFlags({ status: 'open', page: 1, limit: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({ page: 1, limit: 2, total: 5 });
      expect(mockPool.query.mock.calls[0][1]).toEqual(['open']);
      expect(mockPool.query.mock.calls[1][1]).toEqual(['open', 2, 0]);
    });

    it('calculates offset for page > 1', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 50 }] })
        .mockResolvedValueOnce({ rows: [] });

      await flagService.listFlags({ status: 'reviewing', page: 3, limit: 10 });

      expect(mockPool.query.mock.calls[1][1]).toEqual(['reviewing', 10, 20]);
    });

    it('uses defaults when no options provided', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 0 }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await flagService.listFlags();

      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 0 });
      expect(mockPool.query.mock.calls[0][1]).toEqual(['open']);
    });
  });

  describe('reviewFlag', () => {
    it('marks flag as reviewing', async () => {
      const flag = { id: 'flag-1', status: 'reviewing', reviewed_by: 'reviewer-1' };
      mockPool.query.mockResolvedValue({ rows: [flag] });

      const result = await flagService.reviewFlag('flag-1', 'reviewer-1');

      expect(result.status).toBe('reviewing');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'reviewing'"),
        ['reviewer-1', 'flag-1']
      );
    });

    it('throws NOT_FOUND if flag not open', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await expect(
        flagService.reviewFlag('nonexistent', 'reviewer-1')
      ).rejects.toThrow('Flag not found or not in open status');
    });
  });

  describe('dismissFlag', () => {
    it('marks flag as dismissed with resolved_at', async () => {
      const flag = { id: 'flag-1', status: 'dismissed', resolved_at: '2026-01-01' };
      mockPool.query.mockResolvedValue({ rows: [flag] });

      const result = await flagService.dismissFlag('flag-1', 'reviewer-1');

      expect(result.status).toBe('dismissed');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'dismissed'"),
        ['reviewer-1', 'flag-1']
      );
    });

    it('throws NOT_FOUND if flag already resolved', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await expect(
        flagService.dismissFlag('flag-1', 'reviewer-1')
      ).rejects.toThrow('Flag not found or already resolved');
    });
  });

  describe('actionFlag', () => {
    it('marks flag as actioned', async () => {
      const flag = { id: 'flag-1', status: 'actioned', resolved_at: '2026-01-01' };
      mockPool.query.mockResolvedValue({ rows: [flag] });

      const result = await flagService.actionFlag('flag-1', 'reviewer-1');

      expect(result.status).toBe('actioned');
    });

    it('throws NOT_FOUND if flag already resolved', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await expect(
        flagService.actionFlag('flag-1', 'reviewer-1')
      ).rejects.toThrow('Flag not found or already resolved');
    });
  });

  describe('getFlagsByTarget', () => {
    it('returns all flags for a target', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ id: 'f1' }, { id: 'f2' }] });

      const result = await flagService.getFlagsByTarget('message', 'msg-1');

      expect(result).toHaveLength(2);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('target_type'),
        ['message', 'msg-1']
      );
    });
  });

  describe('getActiveFlagCount', () => {
    it('sums account and message flags', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ count: 2 }] }) // account flags
        .mockResolvedValueOnce({ rows: [{ count: 3 }] }); // message flags

      const count = await flagService.getActiveFlagCount('acc-1');

      expect(count).toBe(5);
    });

    it('returns 0 when no active flags', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ count: 0 }] });

      const count = await flagService.getActiveFlagCount('acc-1');

      expect(count).toBe(0);
    });
  });
});
