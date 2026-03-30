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

  it('merges proposed chunks past timeout with zero down-votes', async () => {
    const oldDate = new Date(Date.now() - 300000).toISOString(); // 5 min ago

    // client.query: BEGIN, candidate query (FOR UPDATE SKIP LOCKED), COMMIT
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({
        rows: [{
          id: 'proposed-1', created_at: oldDate, parent_chunk_id: 'orig-1',
          sensitivity: 'low',
        }],
      })
      .mockResolvedValueOnce({}); // COMMIT

    // pool.query: down-vote check
    mockPool.query.mockResolvedValueOnce({ rows: [{ down_count: 0 }] });

    chunkService.mergeChunk.mockResolvedValueOnce({ id: 'proposed-1', status: 'published' });

    await checkAndAutoMerge();

    expect(chunkService.mergeChunk).toHaveBeenCalledWith(
      'proposed-1',
      '00000000-0000-0000-0000-000000000000'
    );
    // Verify FOR UPDATE OF c SKIP LOCKED is in the query
    const candidateQuery = mockClient.query.mock.calls[1][0];
    expect(candidateQuery).toContain('FOR UPDATE OF c SKIP LOCKED');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('skips proposed chunks with down-votes', async () => {
    const oldDate = new Date(Date.now() - 300000).toISOString();

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({
        rows: [{
          id: 'proposed-2', created_at: oldDate, parent_chunk_id: 'orig-2',
          sensitivity: 'low',
        }],
      })
      .mockResolvedValueOnce({}); // COMMIT

    mockPool.query.mockResolvedValueOnce({ rows: [{ down_count: 3 }] });

    await checkAndAutoMerge();

    expect(chunkService.mergeChunk).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('respects high-sensitivity timeout', async () => {
    const recentDate = new Date(Date.now() - 90000).toISOString();

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({
        rows: [{
          id: 'proposed-3', created_at: recentDate, parent_chunk_id: 'orig-3',
          sensitivity: 'high',
        }],
      })
      .mockResolvedValueOnce({}); // COMMIT

    await checkAndAutoMerge();

    expect(chunkService.mergeChunk).not.toHaveBeenCalled();
  });

  it('handles no candidates', async () => {
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // no candidates
      .mockResolvedValueOnce({}); // COMMIT

    await checkAndAutoMerge();

    expect(chunkService.mergeChunk).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('handles NOT_FOUND from mergeChunk as benign race condition', async () => {
    const oldDate = new Date(Date.now() - 300000).toISOString();

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ id: 'proposed-4', created_at: oldDate, sensitivity: 'low' }],
      })
      .mockResolvedValueOnce({}); // COMMIT

    mockPool.query.mockResolvedValueOnce({ rows: [{ down_count: 0 }] });
    chunkService.mergeChunk.mockRejectedValueOnce(
      Object.assign(new Error('Not found'), { code: 'NOT_FOUND' })
    );

    // Should not throw
    await checkAndAutoMerge();

    expect(chunkService.mergeChunk).toHaveBeenCalled();
  });
});
