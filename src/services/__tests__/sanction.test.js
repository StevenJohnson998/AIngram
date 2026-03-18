jest.mock('../../config/database');
jest.mock('../flag');

const { getPool } = require('../../config/database');
const flagService = require('../flag');
const sanctionService = require('../sanction');

describe('sanction service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('determineSanctionType', () => {
    it('returns vote_suspension for first minor offense', () => {
      expect(sanctionService.determineSanctionType('minor', 0)).toBe('vote_suspension');
    });

    it('returns rate_limit for second minor offense', () => {
      expect(sanctionService.determineSanctionType('minor', 1)).toBe('rate_limit');
    });

    it('returns account_freeze for third+ minor offense', () => {
      expect(sanctionService.determineSanctionType('minor', 2)).toBe('account_freeze');
      expect(sanctionService.determineSanctionType('minor', 5)).toBe('account_freeze');
    });

    it('returns ban for grave offense regardless of prior count', () => {
      expect(sanctionService.determineSanctionType('grave', 0)).toBe('ban');
      expect(sanctionService.determineSanctionType('grave', 3)).toBe('ban');
    });
  });

  describe('createSanction', () => {
    it('creates vote_suspension for first minor offense', async () => {
      const sanction = { id: 's-1', type: 'vote_suspension', severity: 'minor' };
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // prior count
        .mockResolvedValueOnce({ rows: [sanction] }); // insert

      const result = await sanctionService.createSanction({
        accountId: 'acc-1',
        severity: 'minor',
        reason: 'spam',
        issuedBy: 'mod-1',
      });

      expect(result.type).toBe('vote_suspension');
      // Should NOT update account status for vote_suspension
      expect(mockPool.query).toHaveBeenCalledTimes(2);
    });

    it('creates rate_limit for second minor offense', async () => {
      const sanction = { id: 's-2', type: 'rate_limit', severity: 'minor' };
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ count: 1 }] }) // 1 prior
        .mockResolvedValueOnce({ rows: [sanction] });

      const result = await sanctionService.createSanction({
        accountId: 'acc-1',
        severity: 'minor',
        reason: 'repeat offense',
        issuedBy: 'mod-1',
      });

      expect(result.type).toBe('rate_limit');
      expect(mockPool.query).toHaveBeenCalledTimes(2);
    });

    it('creates account_freeze and suspends account for 3rd minor', async () => {
      const sanction = { id: 's-3', type: 'account_freeze', severity: 'minor' };
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ count: 2 }] }) // 2 prior
        .mockResolvedValueOnce({ rows: [sanction] }) // insert
        .mockResolvedValueOnce({ rowCount: 1 }); // update account status

      const result = await sanctionService.createSanction({
        accountId: 'acc-1',
        severity: 'minor',
        reason: 'third strike',
        issuedBy: 'mod-1',
      });

      expect(result.type).toBe('account_freeze');
      expect(mockPool.query).toHaveBeenCalledTimes(3);
      expect(mockPool.query.mock.calls[2][0]).toContain("status = 'suspended'");
    });

    it('creates ban and updates account for grave offense', async () => {
      const sanction = { id: 's-4', type: 'ban', severity: 'grave' };
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // prior count (irrelevant)
        .mockResolvedValueOnce({ rows: [sanction] }) // insert
        .mockResolvedValueOnce({ rowCount: 1 }); // update account status

      // Mock postBanAudit (it runs async, mock the queries it would make)
      mockPool.query
        .mockResolvedValueOnce({ rows: [] }) // messages query
        .mockResolvedValueOnce({ rows: [] }); // chunks query

      const result = await sanctionService.createSanction({
        accountId: 'acc-1',
        severity: 'grave',
        reason: 'extreme abuse',
        issuedBy: 'mod-1',
      });

      expect(result.type).toBe('ban');
      expect(mockPool.query.mock.calls[2][0]).toContain("status = 'banned'");
    });
  });

  describe('liftSanction', () => {
    it('lifts sanction and sets probation', async () => {
      const sanction = { id: 's-1', account_id: 'acc-1', active: false, lifted_at: '2026-01-01' };
      mockPool.query
        .mockResolvedValueOnce({ rows: [sanction] }) // update sanction
        .mockResolvedValueOnce({ rowCount: 1 }); // update account

      const result = await sanctionService.liftSanction('s-1');

      expect(result.active).toBe(false);
      expect(mockPool.query.mock.calls[0][0]).toContain('active = false');
      expect(mockPool.query.mock.calls[1][0]).toContain('probation_until');
      expect(mockPool.query.mock.calls[1][0]).toContain("interval '30 days'");
    });

    it('restores suspended account to active', async () => {
      const sanction = { id: 's-1', account_id: 'acc-1' };
      mockPool.query
        .mockResolvedValueOnce({ rows: [sanction] })
        .mockResolvedValueOnce({ rowCount: 1 });

      await sanctionService.liftSanction('s-1');

      // Check the update query handles suspended -> active
      const updateQuery = mockPool.query.mock.calls[1][0];
      expect(updateQuery).toContain("WHEN status = 'suspended' THEN 'active'");
    });

    it('throws NOT_FOUND if sanction not found or already lifted', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await expect(
        sanctionService.liftSanction('nonexistent')
      ).rejects.toThrow('Sanction not found or already lifted');
    });
  });

  describe('getActiveSanctions', () => {
    it('returns active sanctions for account', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ id: 's-1' }, { id: 's-2' }] });

      const result = await sanctionService.getActiveSanctions('acc-1');

      expect(result).toHaveLength(2);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('active = true'),
        ['acc-1']
      );
    });
  });

  describe('getSanctionHistory', () => {
    it('returns paginated history', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 10 }] })
        .mockResolvedValueOnce({ rows: [{ id: 's-1' }] });

      const result = await sanctionService.getSanctionHistory('acc-1', { page: 1, limit: 5 });

      expect(result.pagination).toEqual({ page: 1, limit: 5, total: 10 });
      expect(result.data).toHaveLength(1);
    });
  });

  describe('listAllActive', () => {
    it('returns paginated active sanctions', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 3 }] })
        .mockResolvedValueOnce({ rows: [{ id: 's-1' }, { id: 's-2' }, { id: 's-3' }] });

      const result = await sanctionService.listAllActive({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(3);
      expect(result.pagination.total).toBe(3);
    });
  });

  describe('isVoteSuspended', () => {
    it('returns true when active vote_suspension exists', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ count: 1 }] });

      const result = await sanctionService.isVoteSuspended('acc-1');

      expect(result).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('vote_suspension'),
        ['acc-1']
      );
    });

    it('returns false when no active vote_suspension', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ count: 0 }] });

      const result = await sanctionService.isVoteSuspended('acc-1');

      expect(result).toBe(false);
    });
  });

  describe('postBanAudit', () => {
    it('flags all messages and chunks by account via INSERT...SELECT', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rowCount: 2 }) // INSERT...SELECT messages
        .mockResolvedValueOnce({ rowCount: 1 }); // INSERT...SELECT chunks

      const result = await sanctionService.postBanAudit('acc-1');

      expect(result).toEqual({ messagesFlag: 2, chunksFlag: 1 });

      // Verify bulk INSERT...SELECT for messages
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("'message'"),
        ['acc-1', expect.stringContaining('Post-ban audit'), 'acc-1']
      );

      // Verify bulk INSERT...SELECT for chunks
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("'chunk'"),
        ['acc-1', expect.stringContaining('Post-ban audit'), 'acc-1']
      );

      // No individual createFlag calls — all done in SQL
      expect(flagService.createFlag).not.toHaveBeenCalled();
    });

    it('uses issuedBy as reporter when provided', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 0 });

      await sanctionService.postBanAudit('acc-1', 'admin-1');

      // reporter_id should be admin-1, not acc-1
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("'message'"),
        ['admin-1', expect.stringContaining('Post-ban audit'), 'acc-1']
      );
    });

    it('handles account with no contributions', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockResolvedValueOnce({ rowCount: 0 });

      const result = await sanctionService.postBanAudit('acc-1');

      expect(result).toEqual({ messagesFlag: 0, chunksFlag: 0 });
      expect(flagService.createFlag).not.toHaveBeenCalled();
    });
  });
});
