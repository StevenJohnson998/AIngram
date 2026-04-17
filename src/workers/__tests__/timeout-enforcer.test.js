/**
 * Tests for timeout enforcer worker.
 * Mocks database interactions to verify correct SQL patterns and logic.
 */

jest.mock('../../config/database');
jest.mock('../../services/changeset');

const { getPool } = require('../../config/database');
const changesetService = require('../../services/changeset');

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

const { enforceFastTrack, enforceCommitDeadline, enforceRevealDeadline, enforceReviewTimeout, enforceInconclusiveVoteTimeout, enforceDisputeTimeout, checkTimeouts } = require('../timeout-enforcer');

beforeEach(() => {
  jest.clearAllMocks();
  getPool.mockReturnValue(mockPool);
  mockPool.connect.mockResolvedValue(mockClient);
});

describe('enforceFastTrack', () => {
  it('merges eligible proposed changesets past fast-track timeout', async () => {
    const oldChangeset = {
      id: 'cs-1',
      created_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), // 4h ago
      sensitivity: 'standard', // 3h timeout
    };

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [oldChangeset] }) // SELECT candidates
      .mockResolvedValueOnce({ rows: [{ down_count: 0 }] }) // Check down-votes
      .mockResolvedValueOnce({}); // COMMIT

    // mergeChangeset succeeds
    changesetService.mergeChangeset.mockResolvedValueOnce({ id: 'cs-1', status: 'published' });

    const count = await enforceFastTrack();
    expect(count).toBe(1);
    expect(changesetService.mergeChangeset).toHaveBeenCalledWith('cs-1', '00000000-0000-0000-0000-000000000000');
  });

  it('skips changesets with down-votes', async () => {
    const oldChangeset = {
      id: 'cs-2',
      created_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      sensitivity: 'standard',
    };

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [oldChangeset] }) // SELECT
      .mockResolvedValueOnce({ rows: [{ down_count: 2 }] }) // Has down-votes
      .mockResolvedValueOnce({}); // COMMIT

    const count = await enforceFastTrack();
    expect(count).toBe(0);
    expect(changesetService.mergeChangeset).not.toHaveBeenCalled();
  });

  it('respects high sensitivity longer timeout', async () => {
    const changeset = {
      id: 'cs-3',
      created_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), // 4h ago
      sensitivity: 'sensitive', // 6h timeout — not yet expired
    };

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [changeset] }) // SELECT
      .mockResolvedValueOnce({}); // COMMIT (no vote check needed, changeset skipped by age)

    const count = await enforceFastTrack();
    expect(count).toBe(0);
    // Should skip because 4h < 6h high-sensitivity timeout
    expect(changesetService.mergeChangeset).not.toHaveBeenCalled();
  });
});

describe('enforceReviewTimeout', () => {
  it('retracts under_review changesets past T_REVIEW', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'cs-r1' }, { id: 'cs-r2' }] }) // UPDATE changesets
      .mockResolvedValueOnce({}) // UPDATE chunks (retract belonging chunks)
      .mockResolvedValueOnce({}) // activity_log cs-r1
      .mockResolvedValueOnce({}); // activity_log cs-r2

    const count = await enforceReviewTimeout();
    expect(count).toBe(2);

    // Verify UPDATE query targets under_review status on changesets
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'under_review'"),
      expect.any(Array)
    );

    // Verify chunks belonging to changesets are also retracted
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('changeset_operations'),
      [['cs-r1', 'cs-r2']]
    );

    // Verify activity logged
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('changeset_timeout'),
      expect.arrayContaining(['00000000-0000-0000-0000-000000000000', 'cs-r1', expect.any(String)])
    );
  });

  it('does nothing when no changesets expired', async () => {
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
  it('transitions changesets from commit to reveal phase', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'cs-c1' }] });

    const count = await enforceCommitDeadline();
    expect(count).toBe(1);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("vote_phase = 'reveal'"),
      expect.any(Array)
    );
    // Verify it targets changesets table
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('changesets'),
      expect.any(Array)
    );
  });
});

describe('enforceRevealDeadline', () => {
  it('resolves changesets past reveal deadline', async () => {
    // SELECT changesets past deadline
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'cs-rv1' }] });

    // tallyAndResolve internals (via mockClient transaction)
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'cs-rv1', status: 'under_review', vote_phase: 'reveal', proposed_by: 'acc-1' }] }) // lock
      .mockResolvedValueOnce({ rows: [] }) // suggestion check
      .mockResolvedValueOnce({ rows: [{ vote_value: 1, weight: 1.0 }, { vote_value: 1, weight: 1.0 }, { vote_value: 1, weight: 1.0 }] }) // votes
      .mockResolvedValueOnce({}) // UPDATE vote_phase
      .mockResolvedValueOnce({}) // activity log
      .mockResolvedValueOnce({}); // COMMIT

    const count = await enforceRevealDeadline();
    expect(count).toBe(1);
  });
});

describe('enforceInconclusiveVoteTimeout', () => {
  it('retracts changesets with inconclusive vote past timeout', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'cs-inc1' }] }) // UPDATE changesets
      .mockResolvedValueOnce({}) // UPDATE chunks
      .mockResolvedValueOnce({}); // activity_log

    const count = await enforceInconclusiveVoteTimeout();
    expect(count).toBe(1);

    // Verify targets under_review with vote_inconclusive_at
    const updateCall = mockPool.query.mock.calls[0];
    expect(updateCall[0]).toContain("status = 'under_review'");
    expect(updateCall[0]).toContain('vote_inconclusive_at');
    expect(updateCall[0]).toContain('vote_phase IS NULL');
    expect(updateCall[0]).toContain('vote_score IS NOT NULL');

    // Verify retract_reason
    expect(updateCall[0]).toContain("retract_reason = 'vote_inconclusive'");

    // Verify activity logged with reason
    const logCall = mockPool.query.mock.calls[2];
    expect(logCall[0]).toContain('changeset_timeout');
    expect(logCall[1][2]).toContain('vote_inconclusive');
  });

  it('does nothing when no inconclusive changesets expired', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const count = await enforceInconclusiveVoteTimeout();
    expect(count).toBe(0);
  });
});

describe('checkTimeouts', () => {
  it('runs all enforcers', async () => {
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
    // Inconclusive vote timeout: none
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Dispute timeout: none
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Copyright review deadline: none
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await checkTimeouts();

    // Should have attempted all six checks without error
    expect(mockClient.query).toHaveBeenCalled();
    expect(mockPool.query).toHaveBeenCalled();
  });
});
