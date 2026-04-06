jest.mock('../../config/database');
jest.mock('../flag');

const { getPool } = require('../../config/database');
const sanctionService = require('../sanction');

describe('sanction cascade', () => {
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

  it('cascades ban to parent + siblings on grave violation by sub-account', async () => {
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // prior count
      .mockResolvedValueOnce({
        rows: [{ id: 's-1', type: 'ban', severity: 'grave', account_id: 'child-1' }],
      }) // INSERT sanction
      .mockResolvedValueOnce({ rowCount: 1 }) // ban account
      // cascadeBanIfNeeded (runs on client, inside transaction):
      .mockResolvedValueOnce({ rows: [{ id: 'child-1', parent_id: 'parent-1' }] }) // lookup account
      .mockResolvedValueOnce({ rowCount: 3 }) // ban parent + all children
      .mockResolvedValueOnce({ rowCount: 2 }) // insert cascade sanction records
      // nullifyVotesOnBan (inside transaction):
      .mockResolvedValueOnce({ rows: [{ id: 'child-1' }, { id: 'parent-1' }] }) // SELECT banned accounts
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE votes SET weight=0
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE formal_votes SET weight=0
      .mockResolvedValueOnce({}); // COMMIT

    // postBanAudit (runs on pool, after commit)
    mockPool.query
      .mockResolvedValueOnce({ rowCount: 0 }) // messages
      .mockResolvedValueOnce({ rowCount: 0 }); // chunks

    const result = await sanctionService.createSanction({
      accountId: 'child-1',
      severity: 'grave',
      reason: 'Grave violation',
      issuedBy: 'mod-1',
    });

    expect(result.type).toBe('ban');

    // Verify cascade ban was called on client (inside transaction)
    const cascadeBanCall = mockClient.query.mock.calls[5]; // 6th call: UPDATE accounts SET status='banned'
    expect(cascadeBanCall[0]).toContain("status = 'banned'");
    expect(cascadeBanCall[1]).toContain('parent-1');

    expect(mockClient.release).toHaveBeenCalled();
  });

  it('does not cascade for root account ban', async () => {
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // prior
      .mockResolvedValueOnce({
        rows: [{ id: 's-2', type: 'ban', severity: 'grave', account_id: 'root-1' }],
      }) // INSERT sanction
      .mockResolvedValueOnce({ rowCount: 1 }) // ban account
      // cascadeBanIfNeeded: lookup account -> no parent
      .mockResolvedValueOnce({ rows: [{ id: 'root-1', parent_id: null }] })
      // nullifyVotesOnBan (inside transaction):
      .mockResolvedValueOnce({ rows: [{ id: 'root-1' }] }) // SELECT banned accounts
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE votes
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE formal_votes
      .mockResolvedValueOnce({}); // COMMIT

    // postBanAudit
    mockPool.query
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 });

    const result = await sanctionService.createSanction({
      accountId: 'root-1',
      severity: 'grave',
      reason: 'Root ban',
      issuedBy: 'mod-1',
    });

    expect(result.type).toBe('ban');
    // 9 client calls: BEGIN, prior, insert, ban, cascade lookup, SELECT banned, UPDATE votes, UPDATE formal_votes, COMMIT
    expect(mockClient.query).toHaveBeenCalledTimes(9);
    expect(mockClient.release).toHaveBeenCalled();
  });
});
