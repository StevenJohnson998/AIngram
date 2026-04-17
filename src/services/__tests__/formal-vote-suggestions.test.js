jest.mock('../../config/database');
jest.mock('../../config/trust', () => ({
  VOTE_WEIGHT_NEW_ACCOUNT: 0.5,
  VOTE_WEIGHT_ESTABLISHED: 1.0,
  VOTER_REP_BASE: 0.5,
}));
jest.mock('../sanction', () => ({
  isVoteSuspended: jest.fn().mockResolvedValue(false),
}));
jest.mock('../changeset', () => ({
  mergeChangeset: jest.fn().mockResolvedValue({}),
  rejectChangeset: jest.fn().mockResolvedValue({}),
  SYSTEM_ACCOUNT_ID: 'system',
}));
jest.mock('../reputation', () => ({
  awardDeliberationBonus: jest.fn().mockResolvedValue({}),
  recalculateChunkTrust: jest.fn().mockResolvedValue(0.5),
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
      // suggestion detection (changeset_operations JOIN chunks) — found suggestion
      mockPool.query.mockResolvedValueOnce({ rows: [{ chunk_type: 'suggestion' }] });
      // UPDATE changesets
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'cs-1',
          vote_phase: 'commit',
          commit_deadline_at: new Date(),
          reveal_deadline_at: new Date(),
        }],
      });

      const result = await formalVoteService.startCommitPhase('cs-1');

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
      // suggestion detection — no suggestion found
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'cs-1', vote_phase: 'commit', commit_deadline_at: new Date(), reveal_deadline_at: new Date() }],
      });

      await formalVoteService.startCommitPhase('cs-1');

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
      // changeset lookup (with is_suggestion subquery)
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'cs-1', vote_phase: 'commit', commit_deadline_at: new Date(Date.now() + 100000), proposed_by: 'other', is_suggestion: true }],
      });
      // account lookup (tier included — T1, below suggestion threshold)
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'acc-1', status: 'active', tier: 1, first_contribution_at: new Date(), created_at: new Date('2025-01-01'), reputation_contribution: 0.5 }],
      });

      await expect(
        formalVoteService.commitVote({ accountId: 'acc-1', changesetId: 'cs-1', commitHash: 'abc123' })
      ).rejects.toThrow('Tier 2+');
    });

    it('allows T2 voter on suggestion chunk', async () => {
      // changeset lookup
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'cs-1', vote_phase: 'commit', commit_deadline_at: new Date(Date.now() + 100000), proposed_by: 'other', is_suggestion: true }],
      });
      // account lookup (tier included — T2, meets suggestion threshold)
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'acc-1', status: 'active', tier: 2, first_contribution_at: new Date(), created_at: new Date('2025-01-01'), reputation_contribution: 0.8 }],
      });
      // upsert vote
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'vote-1', weight: 1.0 }] });

      const result = await formalVoteService.commitVote({ accountId: 'acc-1', changesetId: 'cs-1', commitHash: 'abc123' });

      expect(result.id).toBe('vote-1');
    });

    it('does not check tier for knowledge chunks', async () => {
      // changeset lookup — not a suggestion
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'cs-1', vote_phase: 'commit', commit_deadline_at: new Date(Date.now() + 100000), proposed_by: 'other', is_suggestion: false }],
      });
      // account lookup
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'acc-1', status: 'active', first_contribution_at: new Date(), created_at: new Date('2025-01-01'), reputation_contribution: 0.5 }],
      });
      // upsert vote (no tier check query expected)
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'vote-1', weight: 0.75 }] });
      // activity_log insert (vote_committed instrumentation)
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await formalVoteService.commitVote({ accountId: 'acc-1', changesetId: 'cs-1', commitHash: 'abc123' });

      expect(result.id).toBe('vote-1');
      // 4 queries: changeset + account + upsert + activity_log (no tier-check query for knowledge chunks)
      expect(mockPool.query).toHaveBeenCalledTimes(4);
    });
  });

  describe('tallyAndResolve — suggestion thresholds', () => {
    it('uses higher quorum and threshold for suggestions', async () => {
      // Lock changeset
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'cs-1', status: 'under_review', vote_phase: 'reveal', proposed_by: 'author-1' }] })
        // suggestion detection — found suggestion
        .mockResolvedValueOnce({ rows: [{ chunk_type: 'suggestion' }] })
        // Fetch revealed votes — 4 voters (below Q_SUGGESTION_MIN=5)
        .mockResolvedValueOnce({
          rows: [
            { vote_value: 1, weight: 1.0 },
            { vote_value: 1, weight: 1.0 },
            { vote_value: 1, weight: 1.0 },
            { vote_value: 1, weight: 1.0 },
          ],
        })
        // UPDATE changesets (vote_phase + vote_score)
        .mockResolvedValueOnce({})
        // activity_log
        .mockResolvedValueOnce({})
        // COMMIT
        .mockResolvedValueOnce({});

      const result = await formalVoteService.tallyAndResolve('cs-1');

      // 4 voters all +1 gives score 1.0 which exceeds TAU but quorum is 5
      expect(result.decision).toBe('no_quorum');
    });
  });
});
