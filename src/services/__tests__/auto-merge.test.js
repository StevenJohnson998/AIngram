jest.mock('../../config/database');
jest.mock('../../config/editorial', () => ({
  MERGE_TIMEOUT_LOW_SENSITIVITY_MS: 60000,   // 1 min for tests
  MERGE_TIMEOUT_HIGH_SENSITIVITY_MS: 120000, // 2 min for tests
  AUTO_MERGE_CHECK_INTERVAL_MS: 5000,
}));
jest.mock('../chunk');

const { getPool } = require('../../config/database');
const chunkService = require('../chunk');
const { checkAndAutoMerge } = require('../auto-merge');

describe('auto-merge', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  it('merges proposed chunks past timeout with zero down-votes', async () => {
    const oldDate = new Date(Date.now() - 300000).toISOString(); // 5 min ago

    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'proposed-1', created_at: oldDate, parent_chunk_id: 'orig-1',
          sensitivity: 'low',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ down_count: 0 }] }); // no down-votes

    chunkService.mergeChunk.mockResolvedValueOnce({ id: 'proposed-1', status: 'active' });

    await checkAndAutoMerge();

    expect(chunkService.mergeChunk).toHaveBeenCalledWith(
      'proposed-1',
      '00000000-0000-0000-0000-000000000000'
    );
  });

  it('skips proposed chunks with down-votes', async () => {
    const oldDate = new Date(Date.now() - 300000).toISOString();

    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'proposed-2', created_at: oldDate, parent_chunk_id: 'orig-2',
          sensitivity: 'low',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ down_count: 3 }] }); // has down-votes

    await checkAndAutoMerge();

    expect(chunkService.mergeChunk).not.toHaveBeenCalled();
  });

  it('respects high-sensitivity timeout', async () => {
    // 90 seconds ago — past low timeout (60s) but within high timeout (120s)
    const recentDate = new Date(Date.now() - 90000).toISOString();

    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'proposed-3', created_at: recentDate, parent_chunk_id: 'orig-3',
        sensitivity: 'high',
      }],
    });

    await checkAndAutoMerge();

    expect(chunkService.mergeChunk).not.toHaveBeenCalled();
  });

  it('handles no candidates', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await checkAndAutoMerge();

    expect(chunkService.mergeChunk).not.toHaveBeenCalled();
  });
});
