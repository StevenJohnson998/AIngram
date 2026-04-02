jest.mock('../../config/database');
jest.mock('../../config/trust', () => ({
  VOTE_WEIGHT_NEW_ACCOUNT: 0.5,
  VOTE_WEIGHT_ESTABLISHED: 1.0,
  NEW_ACCOUNT_THRESHOLD_DAYS: 14,
  VOTER_REP_BASE: 0.5,
}));
jest.mock('../reputation', () => ({
  awardDeliberationBonus: jest.fn().mockResolvedValue({}),
  recalculateChunkTrust: jest.fn().mockResolvedValue(0.5),
}));
jest.mock('../sanction', () => ({
  isVoteSuspended: jest.fn().mockResolvedValue(false),
}));

const { getPool } = require('../../config/database');
const formalVoteService = require('../formal-vote');
const { hashCommitment } = require('../../../build/domain/formal-vote');
const reputationService = require('../reputation');
const { isVoteSuspended } = require('../sanction');

describe('formal-vote service', () => {
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
    it('sets vote_phase to commit with deadlines', async () => {
      // chunk_type lookup
      mockPool.query.mockResolvedValueOnce({ rows: [{ chunk_type: 'knowledge' }] });
      // UPDATE
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'chunk-1', vote_phase: 'commit', commit_deadline_at: new Date(), reveal_deadline_at: new Date() }],
      });

      const result = await formalVoteService.startCommitPhase('chunk-1');

      expect(result.vote_phase).toBe('commit');
      const sql = mockPool.query.mock.calls[1][0];
      expect(sql).toContain("vote_phase = 'commit'");
      expect(sql).toContain("status = 'under_review'");
    });

    it('throws NOT_FOUND if chunk is not under_review', async () => {
      // chunk_type lookup
      mockPool.query.mockResolvedValueOnce({ rows: [{ chunk_type: 'knowledge' }] });
      // UPDATE returns empty
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(formalVoteService.startCommitPhase('chunk-x'))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('commitVote', () => {
    const chunkInCommit = {
      id: 'chunk-1',
      vote_phase: 'commit',
      commit_deadline_at: new Date(Date.now() + 86400000), // 24h from now
      created_by: 'author-1',
      chunk_type: 'knowledge',
    };

    const activeAccount = {
      id: 'voter-1',
      status: 'active',
      first_contribution_at: '2026-01-01T00:00:00Z',
      created_at: '2025-12-01T00:00:00Z', // > 14 days ago
      reputation_contribution: 0.5,
    };

    it('inserts a formal vote with commit hash and weight', async () => {
      const formalVote = { id: 'fv-1', chunk_id: 'chunk-1', account_id: 'voter-1', commit_hash: 'abc123', weight: 1.0 };

      mockPool.query
        .mockResolvedValueOnce({ rows: [chunkInCommit] }) // chunk lookup
        .mockResolvedValueOnce({ rows: [activeAccount] }) // account lookup
        .mockResolvedValueOnce({ rows: [formalVote] }); // upsert

      const result = await formalVoteService.commitVote({
        accountId: 'voter-1',
        chunkId: 'chunk-1',
        commitHash: 'abc123',
      });

      expect(result).toEqual(formalVote);
      const upsertSql = mockPool.query.mock.calls[2][0];
      expect(upsertSql).toContain('INSERT INTO formal_votes');
      expect(upsertSql).toContain('ON CONFLICT');
    });

    it('rejects when chunk is not in commit phase', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ ...chunkInCommit, vote_phase: 'reveal' }],
      });

      await expect(formalVoteService.commitVote({
        accountId: 'voter-1',
        chunkId: 'chunk-1',
        commitHash: 'abc',
      })).rejects.toMatchObject({ code: 'INVALID_PHASE' });
    });

    it('rejects self-voting (chunk author)', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ ...chunkInCommit, created_by: 'voter-1' }],
      });

      await expect(formalVoteService.commitVote({
        accountId: 'voter-1',
        chunkId: 'chunk-1',
        commitHash: 'abc',
      })).rejects.toMatchObject({ code: 'SELF_VOTE' });
    });

    it('rejects inactive accounts', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [chunkInCommit] })
        .mockResolvedValueOnce({ rows: [{ ...activeAccount, status: 'provisional' }] });

      await expect(formalVoteService.commitVote({
        accountId: 'voter-1',
        chunkId: 'chunk-1',
        commitHash: 'abc',
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rejects accounts without first contribution', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [chunkInCommit] })
        .mockResolvedValueOnce({ rows: [{ ...activeAccount, first_contribution_at: null }] });

      await expect(formalVoteService.commitVote({
        accountId: 'voter-1',
        chunkId: 'chunk-1',
        commitHash: 'abc',
      })).rejects.toMatchObject({ code: 'VOTE_LOCKED' });
    });

    it('rejects vote-suspended accounts', async () => {
      isVoteSuspended.mockResolvedValueOnce(true);

      mockPool.query
        .mockResolvedValueOnce({ rows: [chunkInCommit] })
        .mockResolvedValueOnce({ rows: [activeAccount] });

      await expect(formalVoteService.commitVote({
        accountId: 'voter-1',
        chunkId: 'chunk-1',
        commitHash: 'abc',
      })).rejects.toMatchObject({ code: 'VOTE_SUSPENDED' });
    });

    it('rejects when commit deadline has passed', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ ...chunkInCommit, commit_deadline_at: new Date(Date.now() - 1000) }],
      });

      await expect(formalVoteService.commitVote({
        accountId: 'voter-1',
        chunkId: 'chunk-1',
        commitHash: 'abc',
      })).rejects.toMatchObject({ code: 'DEADLINE_PASSED' });
    });
  });

  describe('revealVote', () => {
    const chunkInReveal = {
      id: 'chunk-1',
      vote_phase: 'reveal',
      reveal_deadline_at: new Date(Date.now() + 43200000), // 12h from now
    };

    const salt = 'test-salt-abc';
    const commitHash = hashCommitment(1, 'accurate', salt);

    const committedVote = {
      id: 'fv-1',
      chunk_id: 'chunk-1',
      account_id: 'voter-1',
      commit_hash: commitHash,
      revealed_at: null,
    };

    it('reveals a vote with matching hash', async () => {
      const revealedVote = { ...committedVote, vote_value: 1, reason_tag: 'accurate', salt, revealed_at: new Date() };

      mockPool.query
        .mockResolvedValueOnce({ rows: [chunkInReveal] }) // chunk lookup
        .mockResolvedValueOnce({ rows: [committedVote] }) // fetch committed vote
        .mockResolvedValueOnce({ rows: [revealedVote] }); // update

      const result = await formalVoteService.revealVote({
        accountId: 'voter-1',
        chunkId: 'chunk-1',
        voteValue: 1,
        reasonTag: 'accurate',
        salt,
      });

      expect(result.vote_value).toBe(1);
      expect(result.reason_tag).toBe('accurate');
    });

    it('rejects when hash does not match', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [chunkInReveal] })
        .mockResolvedValueOnce({ rows: [committedVote] });

      await expect(formalVoteService.revealVote({
        accountId: 'voter-1',
        chunkId: 'chunk-1',
        voteValue: -1, // Different from committed value (1)
        reasonTag: 'accurate',
        salt,
      })).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    });

    it('rejects missing reason_tag', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [chunkInReveal] });

      await expect(formalVoteService.revealVote({
        accountId: 'voter-1',
        chunkId: 'chunk-1',
        voteValue: 1,
        reasonTag: null,
        salt,
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects invalid reason_tag', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [chunkInReveal] });

      await expect(formalVoteService.revealVote({
        accountId: 'voter-1',
        chunkId: 'chunk-1',
        voteValue: 1,
        reasonTag: 'bogus_tag',
        salt,
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects reveal during commit phase', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ ...chunkInReveal, vote_phase: 'commit' }],
      });

      await expect(formalVoteService.revealVote({
        accountId: 'voter-1',
        chunkId: 'chunk-1',
        voteValue: 1,
        reasonTag: 'accurate',
        salt,
      })).rejects.toMatchObject({ code: 'INVALID_PHASE' });
    });

    it('rejects already revealed vote', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [chunkInReveal] })
        .mockResolvedValueOnce({ rows: [{ ...committedVote, revealed_at: new Date() }] });

      await expect(formalVoteService.revealVote({
        accountId: 'voter-1',
        chunkId: 'chunk-1',
        voteValue: 1,
        reasonTag: 'accurate',
        salt,
      })).rejects.toMatchObject({ code: 'ALREADY_REVEALED' });
    });
  });

  describe('tallyAndResolve', () => {
    it('accepts chunk when score >= TAU_ACCEPT with quorum', async () => {
      const votes = [
        { vote_value: 1, weight: 1.0 },
        { vote_value: 1, weight: 1.0 },
        { vote_value: 1, weight: 1.0 },
      ];

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'chunk-1', status: 'under_review', vote_phase: 'reveal' }] }) // lock
        .mockResolvedValueOnce({ rows: votes }) // fetch revealed votes
        .mockResolvedValueOnce({}) // combined UPDATE (vote_phase + status)
        .mockResolvedValueOnce({}) // activity log
        .mockResolvedValueOnce({}); // COMMIT

      const result = await formalVoteService.tallyAndResolve('chunk-1');

      expect(result.decision).toBe('accept');
      expect(result.score).toBe(3.0);
      expect(result.revealedCount).toBe(3);

      const updateSql = mockClient.query.mock.calls[3][0];
      expect(updateSql).toContain("status = 'published'");
      expect(updateSql).toContain("vote_phase = 'resolved'");
    });

    it('rejects chunk when score <= TAU_REJECT', async () => {
      const votes = [
        { vote_value: -1, weight: 1.0 },
        { vote_value: -1, weight: 1.0 },
        { vote_value: -1, weight: 1.0 },
      ];

      mockClient.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'chunk-1', status: 'under_review', vote_phase: 'reveal' }] })
        .mockResolvedValueOnce({ rows: votes })
        .mockResolvedValueOnce({}) // combined UPDATE (vote_phase + status)
        .mockResolvedValueOnce({}) // activity log
        .mockResolvedValueOnce({}); // COMMIT

      const result = await formalVoteService.tallyAndResolve('chunk-1');

      expect(result.decision).toBe('reject');
      expect(result.score).toBe(-3.0);

      const updateSql = mockClient.query.mock.calls[3][0];
      expect(updateSql).toContain("status = 'retracted'");
      expect(updateSql).toContain("vote_phase = 'resolved'");
      expect(updateSql).toContain("rejection_category = 'other'");
    });

    it('returns indeterminate when between thresholds with quorum', async () => {
      const votes = [
        { vote_value: 1, weight: 0.5 },
        { vote_value: -1, weight: 0.5 },
        { vote_value: 1, weight: 0.3 },
      ];

      mockClient.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'chunk-1', status: 'under_review', vote_phase: 'reveal' }] })
        .mockResolvedValueOnce({ rows: votes })
        .mockResolvedValueOnce({}) // combined UPDATE (vote_phase only)
        .mockResolvedValueOnce({}) // activity log
        .mockResolvedValueOnce({}); // COMMIT

      const result = await formalVoteService.tallyAndResolve('chunk-1');

      expect(result.decision).toBe('indeterminate');
    });

    it('returns no_quorum when below Q_MIN revealed votes', async () => {
      const votes = [
        { vote_value: 1, weight: 1.0 },
        { vote_value: 1, weight: 1.0 },
      ];

      mockClient.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'chunk-1', status: 'under_review', vote_phase: 'reveal' }] })
        .mockResolvedValueOnce({ rows: votes })
        .mockResolvedValueOnce({}) // combined UPDATE (vote_phase only)
        .mockResolvedValueOnce({}) // activity log
        .mockResolvedValueOnce({}); // COMMIT

      const result = await formalVoteService.tallyAndResolve('chunk-1');

      expect(result.decision).toBe('no_quorum');
    });

    it('returns null if chunk already resolved (skip locked)', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }); // SKIP LOCKED → nothing found

      const result = await formalVoteService.tallyAndResolve('chunk-1');

      expect(result).toBeNull();
      expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('ROLLBACK'));
    });

    it('calls recalculateChunkTrust after successful tally', async () => {
      const votes = [
        { vote_value: 1, weight: 1.0 },
        { vote_value: 1, weight: 1.0 },
        { vote_value: 1, weight: 1.0 },
      ];

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'chunk-1', status: 'under_review', vote_phase: 'reveal' }] })
        .mockResolvedValueOnce({ rows: votes })
        .mockResolvedValueOnce({}) // UPDATE
        .mockResolvedValueOnce({}) // activity log
        .mockResolvedValueOnce({}); // COMMIT

      await formalVoteService.tallyAndResolve('chunk-1');

      // Allow fire-and-forget to complete
      await new Promise(r => setTimeout(r, 50));

      expect(reputationService.recalculateChunkTrust).toHaveBeenCalledWith('chunk-1');
    });
  });

  describe('getVoteStatus', () => {
    it('returns hidden results during commit phase', async () => {
      const deadline = new Date(Date.now() + 86400000);
      mockPool.query
        .mockResolvedValueOnce({
          rows: [{ id: 'chunk-1', status: 'under_review', vote_phase: 'commit', commit_deadline_at: deadline, reveal_deadline_at: deadline, vote_score: null }],
        })
        .mockResolvedValueOnce({ rows: [{ commit_count: 2, revealed_count: 0 }] })
        .mockResolvedValueOnce({ rows: [] }); // my vote check

      const result = await formalVoteService.getVoteStatus('chunk-1', 'viewer-1');

      expect(result.phase).toBe('commit');
      expect(result.status).toBe('voting_in_progress');
      expect(result.results).toBe('hidden');
      expect(result.commitCount).toBe(2);
    });

    it('returns hidden results during reveal phase', async () => {
      const deadline = new Date(Date.now() + 43200000);
      mockPool.query
        .mockResolvedValueOnce({
          rows: [{ id: 'chunk-1', status: 'under_review', vote_phase: 'reveal', commit_deadline_at: deadline, reveal_deadline_at: deadline, vote_score: null }],
        })
        .mockResolvedValueOnce({ rows: [{ commit_count: 3, revealed_count: 1 }] })
        .mockResolvedValueOnce({ rows: [{ revealed_at: null }] }); // committed but not revealed

      const result = await formalVoteService.getVoteStatus('chunk-1', 'voter-1');

      expect(result.phase).toBe('reveal');
      expect(result.results).toBe('hidden');
      expect(result.hasCommitted).toBe(true);
      expect(result.hasRevealed).toBe(false);
    });

    it('returns full results when resolved', async () => {
      mockPool.query
        .mockResolvedValueOnce({
          rows: [{ id: 'chunk-1', status: 'published', vote_phase: 'resolved', commit_deadline_at: new Date(), reveal_deadline_at: new Date(), vote_score: 2.5 }],
        })
        .mockResolvedValueOnce({ rows: [{ commit_count: 3, revealed_count: 3 }] })
        // No my-vote query when requestingAccountId is null
        .mockResolvedValueOnce({ rows: [
          { account_id: 'v1', vote_value: 1, reason_tag: 'accurate', weight: 1.0, revealed_at: new Date(), name: 'Agent A' },
        ] });

      const result = await formalVoteService.getVoteStatus('chunk-1', null);

      expect(result.phase).toBe('resolved');
      expect(result.status).toBe('decided');
      expect(result.score).toBe(2.5);
      expect(result.votes).toHaveLength(1);
      expect(result.votes[0].voteValue).toBe(1);
    });

    it('returns null phase when no formal vote active', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'chunk-1', status: 'proposed', vote_phase: null, commit_deadline_at: null, reveal_deadline_at: null, vote_score: null }],
      });

      const result = await formalVoteService.getVoteStatus('chunk-1', null);

      expect(result.phase).toBeNull();
    });
  });
});
