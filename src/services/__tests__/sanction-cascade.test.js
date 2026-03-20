jest.mock('../../config/database');
jest.mock('../flag');

const { getPool } = require('../../config/database');
const sanctionService = require('../sanction');

describe('sanction cascade', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  it('cascades ban to parent + siblings on grave violation by sub-account', async () => {
    // Count prior minor sanctions
    mockPool.query.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    // INSERT sanction
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 's-1', type: 'ban', severity: 'grave', account_id: 'child-1' }],
    });
    // Ban the account
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    // cascadeBanIfNeeded: lookup account
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'child-1', parent_id: 'parent-1' }],
    });
    // cascade: ban parent + all children
    mockPool.query.mockResolvedValueOnce({ rowCount: 3 });
    // cascade: insert sanction records
    mockPool.query.mockResolvedValueOnce({ rowCount: 2 });

    // postBanAudit: messages + chunks
    mockPool.query.mockResolvedValueOnce({ rowCount: 0 });
    mockPool.query.mockResolvedValueOnce({ rowCount: 0 });

    const result = await sanctionService.createSanction({
      accountId: 'child-1',
      severity: 'grave',
      reason: 'Grave violation',
      issuedBy: 'mod-1',
    });

    expect(result.type).toBe('ban');

    // Verify cascade ban was called
    const cascadeBanCall = mockPool.query.mock.calls[4]; // 5th call: UPDATE accounts SET status='banned'
    expect(cascadeBanCall[0]).toContain("status = 'banned'");
    expect(cascadeBanCall[1]).toContain('parent-1');
  });

  it('does not cascade for root account ban', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ count: 0 }] }); // prior
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 's-2', type: 'ban', severity: 'grave', account_id: 'root-1' }],
    });
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 }); // ban account

    // cascadeBanIfNeeded: lookup account -> no parent
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'root-1', parent_id: null }],
    });

    // postBanAudit
    mockPool.query.mockResolvedValueOnce({ rowCount: 0 });
    mockPool.query.mockResolvedValueOnce({ rowCount: 0 });

    const result = await sanctionService.createSanction({
      accountId: 'root-1',
      severity: 'grave',
      reason: 'Root ban',
      issuedBy: 'mod-1',
    });

    expect(result.type).toBe('ban');
    // Only 6 calls total (no cascade queries)
    expect(mockPool.query).toHaveBeenCalledTimes(6);
  });
});
