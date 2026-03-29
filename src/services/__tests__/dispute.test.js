jest.mock('../../config/database');
jest.mock('../../domain', () => ({
  transition: jest.fn(),
  retractReasonForEvent: jest.fn().mockReturnValue('rejected'),
}));
jest.mock('../../config/protocol', () => ({
  OBJECTION_REASON_TAGS: ['inaccurate', 'unsourced', 'redundant', 'harmful', 'unclear', 'copyright'],
}));

const { getPool } = require('../../config/database');
const { transition } = require('../../domain');
const disputeService = require('../dispute');

describe('dispute service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('fileDispute', () => {
    it('transitions active chunk to disputed', async () => {
      const chunk = { id: 'c1', status: 'disputed', disputed_at: new Date().toISOString() };
      // UPDATE (atomic transition)
      mockPool.query.mockResolvedValueOnce({ rows: [chunk] });
      // Activity log INSERT
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await disputeService.fileDispute('c1', {
        disputedBy: 'acc-1',
        reason: 'This content is inaccurate and misleading',
        reasonTag: 'inaccurate',
      });

      expect(result).toEqual(chunk);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'disputed'"),
        ['c1']
      );
    });

    it('rejects dispute on non-active chunk', async () => {
      // UPDATE returns nothing (not in active state)
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // SELECT for error message
      mockPool.query.mockResolvedValueOnce({ rows: [{ status: 'proposed' }] });
      transition.mockImplementation(() => { throw new Error('Invalid transition'); });

      await expect(
        disputeService.fileDispute('c1', {
          disputedBy: 'acc-1',
          reason: 'This content is inaccurate and misleading',
          reasonTag: 'inaccurate',
        })
      ).rejects.toThrow();
    });

    it('rejects invalid reason tag', async () => {
      await expect(
        disputeService.fileDispute('c1', {
          disputedBy: 'acc-1',
          reason: 'This content is wrong and should be removed',
          reasonTag: 'invalid_tag',
        })
      ).rejects.toThrow('reasonTag must be one of');
    });

    it('rejects short reason', async () => {
      await expect(
        disputeService.fileDispute('c1', {
          disputedBy: 'acc-1',
          reason: 'bad',
          reasonTag: 'inaccurate',
        })
      ).rejects.toThrow('minimum 10 characters');
    });

    it('returns NOT_FOUND for non-existent chunk', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        disputeService.fileDispute('nonexistent', {
          disputedBy: 'acc-1',
          reason: 'This content should not exist here',
          reasonTag: 'inaccurate',
        })
      ).rejects.toThrow('Chunk not found');
    });
  });

  describe('resolveDispute', () => {
    it('upholds dispute (disputed -> active)', async () => {
      const chunk = { id: 'c1', status: 'active' };
      mockPool.query.mockResolvedValueOnce({ rows: [chunk] });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await disputeService.resolveDispute('c1', {
        resolvedBy: 'admin-1',
        verdict: 'upheld',
      });

      expect(result.status).toBe('active');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'active'"),
        ['c1']
      );
    });

    it('removes chunk (disputed -> retracted)', async () => {
      const chunk = { id: 'c1', status: 'retracted', retract_reason: 'rejected' };
      mockPool.query.mockResolvedValueOnce({ rows: [chunk] });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await disputeService.resolveDispute('c1', {
        resolvedBy: 'admin-1',
        verdict: 'removed',
        notes: 'Content was plagiarized',
      });

      expect(result.status).toBe('retracted');
    });

    it('rejects invalid verdict', async () => {
      await expect(
        disputeService.resolveDispute('c1', {
          resolvedBy: 'admin-1',
          verdict: 'maybe',
        })
      ).rejects.toThrow('verdict must be one of');
    });
  });

  describe('listDisputed', () => {
    it('returns paginated disputed chunks', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 2 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'c1' }, { id: 'c2' }] });

      const result = await disputeService.listDisputed({ page: 1, limit: 10 });

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({ page: 1, limit: 10, total: 2 });
    });
  });
});
