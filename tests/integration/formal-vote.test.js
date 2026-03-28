/**
 * Formal vote integration tests — mock-based tests for routes and timeout enforcer.
 * Tests the full commit-reveal voting flow through HTTP routes.
 */

jest.mock('../../src/config/database');
jest.mock('../../src/config/trust', () => ({
  VOTE_WEIGHT_NEW_ACCOUNT: 0.5,
  VOTE_WEIGHT_ESTABLISHED: 1.0,
  NEW_ACCOUNT_THRESHOLD_DAYS: 14,
  VOTER_REP_BASE: 0.5,
}));

const { getPool } = require('../../src/config/database');
const { hashCommitment } = require('../../build/domain/formal-vote');
const timeoutEnforcer = require('../../src/workers/timeout-enforcer');

describe('formal vote timeout enforcer', () => {
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

  describe('enforceCommitDeadline', () => {
    it('transitions chunks from commit to reveal phase', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'chunk-1' }, { id: 'chunk-2' }],
      });

      const count = await timeoutEnforcer.enforceCommitDeadline();

      expect(count).toBe(2);
      const sql = mockPool.query.mock.calls[0][0];
      expect(sql).toContain("vote_phase = 'reveal'");
      expect(sql).toContain("vote_phase = 'commit'");
      expect(sql).toContain('commit_deadline_at');
    });

    it('returns 0 when no chunks need transition', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const count = await timeoutEnforcer.enforceCommitDeadline();

      expect(count).toBe(0);
    });
  });

  describe('enforceRevealDeadline', () => {
    it('tallies and resolves chunks past reveal deadline', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'chunk-1' }],
      });

      // Mock tallyAndResolve internals (via mockClient for transaction)
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: 'chunk-1', status: 'under_review', vote_phase: 'reveal' }],
        }) // FOR UPDATE SKIP LOCKED
        .mockResolvedValueOnce({
          rows: [
            { vote_value: 1, weight: 1.0 },
            { vote_value: 1, weight: 1.0 },
            { vote_value: 1, weight: 1.0 },
          ],
        }) // revealed votes
        .mockResolvedValueOnce({}) // combined UPDATE (vote_phase + status)
        .mockResolvedValueOnce({}) // activity log
        .mockResolvedValueOnce({}); // COMMIT

      const count = await timeoutEnforcer.enforceRevealDeadline();

      expect(count).toBe(1);
    });
  });

  describe('enforceReviewTimeout guards formal votes', () => {
    it('skips chunks with active vote phases', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await timeoutEnforcer.enforceReviewTimeout();

      const sql = mockPool.query.mock.calls[0][0];
      expect(sql).toContain('vote_phase IS NULL');
    });
  });
});

describe('formal vote domain: full commit-reveal cycle', () => {
  it('hash → commit → verify reveal → compute score → evaluate decision', () => {
    const { hashCommitment, verifyReveal, computeVoteScore, evaluateDecision, clampWeight } = require('../../build/domain/formal-vote');

    // Three voters prepare their votes
    const votes = [
      { value: 1, tag: 'accurate', salt: 'salt-voter-a' },
      { value: 1, tag: 'well_sourced', salt: 'salt-voter-b' },
      { value: -1, tag: 'inaccurate', salt: 'salt-voter-c' },
    ];

    // Commit phase: each voter hashes their vote
    const commitments = votes.map(v => hashCommitment(v.value, v.tag, v.salt));

    // Verify each commitment is a valid 64-char hex hash
    for (const hash of commitments) {
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    }

    // All commitments are unique
    const uniqueHashes = new Set(commitments);
    expect(uniqueHashes.size).toBe(3);

    // Reveal phase: verify each reveal matches its commitment
    for (let i = 0; i < votes.length; i++) {
      const v = votes[i];
      expect(verifyReveal(commitments[i], v.value, v.tag, v.salt)).toBe(true);
    }

    // Compute weighted score (all weights 1.0 after clamping)
    const weightedVotes = votes.map(v => ({
      weight: clampWeight(1.0, 0.1, 5.0),
      voteValue: v.value,
    }));
    const score = computeVoteScore(weightedVotes);
    expect(score).toBeCloseTo(1.0); // +1 +1 -1 = 1

    // Evaluate decision: score=1.0 >= TAU_ACCEPT=0.6, quorum=3 >= Q_MIN=3
    const decision = evaluateDecision(score, 3, 3, 0.6, -0.3);
    expect(decision).toBe('accept');
  });

  it('rejects when majority vote negative', () => {
    const { computeVoteScore, evaluateDecision } = require('../../build/domain/formal-vote');

    const weightedVotes = [
      { weight: 1.0, voteValue: -1 },
      { weight: 1.5, voteValue: -1 },
      { weight: 0.8, voteValue: 1 },
    ];
    const score = computeVoteScore(weightedVotes);
    expect(score).toBeCloseTo(-1.7);

    const decision = evaluateDecision(score, 3, 3, 0.6, -0.3);
    expect(decision).toBe('reject');
  });

  it('returns no_quorum when insufficient voters', () => {
    const { computeVoteScore, evaluateDecision } = require('../../build/domain/formal-vote');

    const score = computeVoteScore([
      { weight: 1.0, voteValue: 1 },
      { weight: 1.0, voteValue: 1 },
    ]);

    const decision = evaluateDecision(score, 2, 3, 0.6, -0.3);
    expect(decision).toBe('no_quorum');
  });

  it('returns indeterminate for split votes', () => {
    const { computeVoteScore, evaluateDecision } = require('../../build/domain/formal-vote');

    const score = computeVoteScore([
      { weight: 1.0, voteValue: 1 },
      { weight: 1.0, voteValue: -1 },
      { weight: 1.0, voteValue: 0 },
    ]);
    expect(score).toBeCloseTo(0.0);

    const decision = evaluateDecision(score, 3, 3, 0.6, -0.3);
    expect(decision).toBe('indeterminate');
  });

  it('tampered reveal fails verification', () => {
    const { hashCommitment, verifyReveal } = require('../../build/domain/formal-vote');

    const hash = hashCommitment(1, 'accurate', 'my-secret-salt');

    // Try to reveal with different vote value
    expect(verifyReveal(hash, -1, 'accurate', 'my-secret-salt')).toBe(false);
    // Try with different salt
    expect(verifyReveal(hash, 1, 'accurate', 'wrong-salt')).toBe(false);
    // Try with different reason
    expect(verifyReveal(hash, 1, 'harmful', 'my-secret-salt')).toBe(false);
    // Correct reveal
    expect(verifyReveal(hash, 1, 'accurate', 'my-secret-salt')).toBe(true);
  });
});
