jest.mock('../../config/database');
jest.mock('../flag');
jest.mock('../reputation', () => ({
  recalculateChunkTrust: jest.fn().mockResolvedValue(0.5),
}));

const { getPool } = require('../../config/database');
const flagService = require('../flag');
const sanctionService = require('../sanction');
const { recalculateChunkTrust } = require('../reputation');

describe('sanction service', () => {
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
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // prior count
        .mockResolvedValueOnce({ rows: [sanction] }) // insert
        .mockResolvedValueOnce({}); // COMMIT

      const result = await sanctionService.createSanction({
        accountId: 'acc-1',
        severity: 'minor',
        reason: 'spam',
        issuedBy: 'mod-1',
      });

      expect(result.type).toBe('vote_suspension');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('creates rate_limit for second minor offense', async () => {
      const sanction = { id: 's-2', type: 'rate_limit', severity: 'minor' };
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: 1 }] }) // 1 prior
        .mockResolvedValueOnce({ rows: [sanction] }) // insert
        .mockResolvedValueOnce({}); // COMMIT

      const result = await sanctionService.createSanction({
        accountId: 'acc-1',
        severity: 'minor',
        reason: 'repeat offense',
        issuedBy: 'mod-1',
      });

      expect(result.type).toBe('rate_limit');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('creates account_freeze and suspends account for 3rd minor', async () => {
      const sanction = { id: 's-3', type: 'account_freeze', severity: 'minor' };
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: 2 }] }) // 2 prior
        .mockResolvedValueOnce({ rows: [sanction] }) // insert
        .mockResolvedValueOnce({ rowCount: 1 }) // update account status
        .mockResolvedValueOnce({}); // COMMIT

      const result = await sanctionService.createSanction({
        accountId: 'acc-1',
        severity: 'minor',
        reason: 'third strike',
        issuedBy: 'mod-1',
      });

      expect(result.type).toBe('account_freeze');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'suspended'"),
        ['acc-1']
      );
    });

    it('creates ban and updates account for grave offense', async () => {
      const sanction = { id: 's-4', type: 'ban', severity: 'grave' };
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // prior count
        .mockResolvedValueOnce({ rows: [sanction] }) // insert
        .mockResolvedValueOnce({ rowCount: 1 }) // ban account
        .mockResolvedValueOnce({ rows: [{ id: 'acc-1', parent_id: null }] }) // cascadeBanIfNeeded: lookup (no parent)
        // nullifyVotesOnBan (inside transaction):
        .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] }) // SELECT banned accounts
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE votes
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE formal_votes
        .mockResolvedValueOnce({}); // COMMIT

      // postBanAudit (runs after COMMIT, uses pool not client)
      mockPool.query
        .mockResolvedValueOnce({ rowCount: 0 }) // messages
        .mockResolvedValueOnce({ rowCount: 0 }); // chunks

      const result = await sanctionService.createSanction({
        accountId: 'acc-1',
        severity: 'grave',
        reason: 'extreme abuse',
        issuedBy: 'mod-1',
      });

      expect(result.type).toBe('ban');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'banned'"),
        ['acc-1']
      );
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('rolls back on error and releases client', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('DB error')); // prior count fails

      await expect(
        sanctionService.createSanction({
          accountId: 'acc-1', severity: 'minor', reason: 'test', issuedBy: 'mod-1',
        })
      ).rejects.toThrow('DB error');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
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
        .mockResolvedValueOnce({ rowCount: 2 })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await sanctionService.postBanAudit('acc-1');

      expect(result).toEqual({ messagesFlag: 2, chunksFlag: 1 });
      expect(flagService.createFlag).not.toHaveBeenCalled();
    });

    it('uses issuedBy as reporter when provided', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 0 });

      await sanctionService.postBanAudit('acc-1', 'admin-1');

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
    });
  });

  describe('nullifyVotesOnBan', () => {
    it('sets weight=0 on all votes by account and recalculates chunks', async () => {
      mockPool.query
        .mockResolvedValueOnce({
          rowCount: 2,
          rows: [
            { target_type: 'chunk', target_id: 'chunk-1' },
            { target_type: 'message', target_id: 'msg-1' },
          ],
        }) // informal votes
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ chunk_id: 'chunk-2' }],
        }); // formal votes

      const result = await sanctionService.nullifyVotesOnBan('acc-1');

      expect(result.votesNullified).toBe(2);
      expect(result.formalVotesNullified).toBe(1);
      expect(result.chunksRecalculated).toBe(2); // chunk-1 + chunk-2

      // Verify SQL uses weight != 0 to avoid redundant updates
      expect(mockPool.query.mock.calls[0][0]).toContain('weight = 0');
      expect(mockPool.query.mock.calls[0][0]).toContain('weight != 0');
    });

    it('accepts array of account IDs for cascade bans', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rowCount: 3, rows: [{ target_type: 'chunk', target_id: 'chunk-1' }] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] });

      await sanctionService.nullifyVotesOnBan(['acc-1', 'acc-2', 'acc-3']);

      expect(mockPool.query.mock.calls[0][1]).toEqual([['acc-1', 'acc-2', 'acc-3']]);
    });

    it('handles accounts with no votes', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const result = await sanctionService.nullifyVotesOnBan('acc-1');

      expect(result.votesNullified).toBe(0);
      expect(result.formalVotesNullified).toBe(0);
      expect(result.chunksRecalculated).toBe(0);
      expect(recalculateChunkTrust).not.toHaveBeenCalled();
    });
  });
});
