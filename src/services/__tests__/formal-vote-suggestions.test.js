jest.mock('../../config/database');
jest.mock('../../config/trust', () => ({
  VOTE_WEIGHT_NEW_ACCOUNT: 0.5,
  VOTE_WEIGHT_ESTABLISHED: 1.0,
  VOTER_REP_BASE: 0.5,
}));

const { getPool } = require('../../config/database');
const formalVoteService = require('../formal-vote');

describe('formal-vote — suggestion chunk awareness', () => {
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

  describe('startCommitPhase', () => {
    it('uses longer timers for suggestion chunks', async () => {
      // chunk_type lookup
      mockPool.query.mockResolvedValueOnce({ rows: [{ chunk_type: 'suggestion' }] });
      // UPDATE
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'chunk-1',
          vote_phase: 'commit',
          commit_deadline_at: new Date(),
          reveal_deadline_at: new Date(),
        }],
      });

      const result = await formalVoteService.startCommitPhase('chunk-1');

      expect(result.vote_phase).toBe('commit');

      // Verify the UPDATE was called with correct deadlines
      const updateCall = mockPool.query.mock.calls[1];
      const commitDeadline = updateCall[1][1];
      const revealDeadline = updateCall[1][2];
      const commitDuration = revealDeadline.getTime() - commitDeadline.getTime();
      // Suggestion reveal should be 24h = 86400000ms
      expect(commitDuration).toBe(24 * 60 * 60 * 1000);
    });

    it('uses standard timers for knowledge chunks', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ chunk_type: 'knowledge' }] });
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'chunk-1', vote_phase: 'commit', commit_deadline_at: new Date(), reveal_deadline_at: new Date() }],
      });

      await formalVoteService.startCommitPhase('chunk-1');

      const updateCall = mockPool.query.mock.calls[1];
      const commitDeadline = updateCall[1][1];
      const revealDeadline = updateCall[1][2];
      const revealDuration = revealDeadline.getTime() - commitDeadline.getTime();
      // Knowledge reveal should be 12h = 43200000ms
      expect(revealDuration).toBe(12 * 60 * 60 * 1000);
    });
  });

  describe('commitVote — tier gate for suggestions', () => {
    it('rejects T0/T1 voter on suggestion chunk', async () => {
      // chunk lookup
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'chunk-1', vote_phase: 'commit', commit_deadline_at: new Date(Date.now() + 100000), created_by: 'other', chunk_type: 'suggestion' }],
      });
      // account lookup
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'acc-1', status: 'active', first_contribution_at: new Date(), created_at: new Date('2025-01-01'), reputation_contribution: 0.5 }],
      });
      // tier lookup — T1
      mockPool.query.mockResolvedValueOnce({ rows: [{ tier: 1 }] });

      await expect(
        formalVoteService.commitVote({ accountId: 'acc-1', chunkId: 'chunk-1', commitHash: 'abc123' })
      ).rejects.toThrow('Tier 2+');
    });

    it('allows T2 voter on suggestion chunk', async () => {
      // chunk lookup
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'chunk-1', vote_phase: 'commit', commit_deadline_at: new Date(Date.now() + 100000), created_by: 'other', chunk_type: 'suggestion' }],
      });
      // account lookup
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'acc-1', status: 'active', first_contribution_at: new Date(), created_at: new Date('2025-01-01'), reputation_contribution: 0.8 }],
      });
      // tier lookup — T2
      mockPool.query.mockResolvedValueOnce({ rows: [{ tier: 2 }] });
      // upsert vote
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'vote-1', weight: 1.0 }] });

      const result = await formalVoteService.commitVote({ accountId: 'acc-1', chunkId: 'chunk-1', commitHash: 'abc123' });

      expect(result.id).toBe('vote-1');
    });

    it('does not check tier for knowledge chunks', async () => {
      // chunk lookup — knowledge type
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'chunk-1', vote_phase: 'commit', commit_deadline_at: new Date(Date.now() + 100000), created_by: 'other', chunk_type: 'knowledge' }],
      });
      // account lookup
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'acc-1', status: 'active', first_contribution_at: new Date(), created_at: new Date('2025-01-01'), reputation_contribution: 0.5 }],
      });
      // upsert vote (no tier check query expected)
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'vote-1', weight: 0.75 }] });

      const result = await formalVoteService.commitVote({ accountId: 'acc-1', chunkId: 'chunk-1', commitHash: 'abc123' });

      expect(result.id).toBe('vote-1');
      // Should be 3 queries total (chunk + account + upsert), not 4 (no tier check)
      expect(mockPool.query).toHaveBeenCalledTimes(3);
    });
  });

  describe('tallyAndResolve — suggestion thresholds', () => {
    it('uses higher quorum and threshold for suggestions', async () => {
      // Lock chunk
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'chunk-1', status: 'under_review', vote_phase: 'reveal', chunk_type: 'suggestion' }] })
        // Fetch revealed votes — 4 voters (below Q_SUGGESTION_MIN=5)
        .mockResolvedValueOnce({
          rows: [
            { vote_value: 1, weight: 1.0 },
            { vote_value: 1, weight: 1.0 },
            { vote_value: 1, weight: 1.0 },
            { vote_value: 1, weight: 1.0 },
          ],
        })
        // UPDATE (indeterminate — below quorum)
        .mockResolvedValueOnce({})
        // activity_log
        .mockResolvedValueOnce({})
        // COMMIT
        .mockResolvedValueOnce({});

      const result = await formalVoteService.tallyAndResolve('chunk-1');

      // 4 voters all +1 gives score 1.0 which exceeds TAU but quorum is 5
      expect(result.decision).toBe('no_quorum');
    });
  });
});
