/**
 * Tests for timeout enforcer worker.
 * Mocks database interactions to verify correct SQL patterns and logic.
 */

jest.mock('../../config/database');
jest.mock('../../services/chunk');

const { getPool } = require('../../config/database');
const chunkService = require('../../services/chunk');

// Stable mock pool
const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

const mockPool = {
  connect: jest.fn().mockResolvedValue(mockClient),
  query: jest.fn(),
};

getPool.mockReturnValue(mockPool);

const { enforceFastTrack, enforceCommitDeadline, enforceRevealDeadline, enforceReviewTimeout, enforceDisputeTimeout, checkTimeouts } = require('../timeout-enforcer');

beforeEach(() => {
  jest.clearAllMocks();
  getPool.mockReturnValue(mockPool);
  mockPool.connect.mockResolvedValue(mockClient);
});

describe('enforceFastTrack', () => {
  it('merges eligible proposed chunks past fast-track timeout', async () => {
    const oldChunk = {
      id: 'chunk-1',
      created_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), // 4h ago
      sensitivity: 'low', // 3h timeout
    };

    // BEGIN
    mockClient.query.mockResolvedValueOnce({});
    // SELECT candidates
    mockClient.query.mockResolvedValueOnce({ rows: [oldChunk] });
    // COMMIT
    mockClient.query.mockResolvedValueOnce({});

    // Check down-votes: none
    mockPool.query.mockResolvedValueOnce({ rows: [{ down_count: 0 }] });

    // mergeChunk succeeds
    chunkService.mergeChunk.mockResolvedValueOnce({ id: 'chunk-1', status: 'active' });

    const count = await enforceFastTrack();
    expect(count).toBe(1);
    expect(chunkService.mergeChunk).toHaveBeenCalledWith('chunk-1', '00000000-0000-0000-0000-000000000000');
  });

  it('skips chunks with down-votes', async () => {
    const oldChunk = {
      id: 'chunk-2',
      created_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      sensitivity: 'low',
    };

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [oldChunk] }) // SELECT
      .mockResolvedValueOnce({}); // COMMIT

    // Has down-votes
    mockPool.query.mockResolvedValueOnce({ rows: [{ down_count: 2 }] });

    const count = await enforceFastTrack();
    expect(count).toBe(0);
    expect(chunkService.mergeChunk).not.toHaveBeenCalled();
  });

  it('respects high sensitivity longer timeout', async () => {
    const chunk = {
      id: 'chunk-3',
      created_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), // 4h ago
      sensitivity: 'high', // 6h timeout — not yet expired
    };

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [chunk] }) // SELECT
      .mockResolvedValueOnce({}); // COMMIT

    const count = await enforceFastTrack();
    expect(count).toBe(0);
    // Should skip because 4h < 6h high-sensitivity timeout
    expect(chunkService.mergeChunk).not.toHaveBeenCalled();
  });
});

describe('enforceReviewTimeout', () => {
  it('retracts under_review chunks past T_REVIEW', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'chunk-r1' }, { id: 'chunk-r2' }] }) // UPDATE
      .mockResolvedValueOnce({}) // activity_log chunk-r1
      .mockResolvedValueOnce({}); // activity_log chunk-r2

    const count = await enforceReviewTimeout();
    expect(count).toBe(2);

    // Verify UPDATE query targets under_review status
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'under_review'"),
      expect.any(Array)
    );

    // Verify activity logged
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('chunk_timeout'),
      expect.arrayContaining(['00000000-0000-0000-0000-000000000000', 'chunk-r1', expect.any(String)])
    );
  });

  it('does nothing when no chunks expired', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const count = await enforceReviewTimeout();
    expect(count).toBe(0);
  });
});

describe('enforceDisputeTimeout', () => {
  it('retracts disputed chunks past T_DISPUTE', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'chunk-d1' }] }) // UPDATE
      .mockResolvedValueOnce({}); // activity_log

    const count = await enforceDisputeTimeout();
    expect(count).toBe(1);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'disputed'"),
      expect.any(Array)
    );
  });
});

describe('enforceCommitDeadline', () => {
  it('transitions chunks from commit to reveal phase', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'chunk-c1' }] });

    const count = await enforceCommitDeadline();
    expect(count).toBe(1);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("vote_phase = 'reveal'"),
      expect.any(Array)
    );
  });
});

describe('enforceRevealDeadline', () => {
  it('resolves chunks past reveal deadline', async () => {
    // SELECT chunks past deadline
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'chunk-rv1' }] });

    // tallyAndResolve internals (via mockClient transaction)
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'chunk-rv1', status: 'under_review', vote_phase: 'reveal' }] }) // lock
      .mockResolvedValueOnce({ rows: [{ vote_value: 1, weight: 1.0 }, { vote_value: 1, weight: 1.0 }, { vote_value: 1, weight: 1.0 }] }) // votes
      .mockResolvedValueOnce({}) // combined UPDATE (vote_phase + status)
      .mockResolvedValueOnce({}) // activity log
      .mockResolvedValueOnce({}); // COMMIT

    const count = await enforceRevealDeadline();
    expect(count).toBe(1);
  });
});

describe('checkTimeouts', () => {
  it('runs all five enforcers', async () => {
    // Fast track: no candidates
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT
      .mockResolvedValueOnce({}); // COMMIT

    // Commit deadline: none
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Reveal deadline: none
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Review timeout: none
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Dispute timeout: none
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await checkTimeouts();

    // Should have attempted all five checks without error
    expect(mockClient.query).toHaveBeenCalled();
    expect(mockPool.query).toHaveBeenCalled();
  });
});
