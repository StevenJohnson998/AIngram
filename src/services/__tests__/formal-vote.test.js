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
jest.mock('../changeset', () => ({
  mergeChangeset: jest.fn().mockResolvedValue({}),
  rejectChangeset: jest.fn().mockResolvedValue({}),
  SYSTEM_ACCOUNT_ID: 'system',
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
      // suggestion detection (changeset_operations JOIN chunks)
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // not a suggestion
      // UPDATE changesets
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'cs-1', vote_phase: 'commit', commit_deadline_at: new Date(), reveal_deadline_at: new Date() }],
      });

      const result = await formalVoteService.startCommitPhase('cs-1');

      expect(result.vote_phase).toBe('commit');
      const sql = mockPool.query.mock.calls[1][0];
      expect(sql).toContain("vote_phase = 'commit'");
      expect(sql).toContain("status = 'under_review'");
    });

    it('throws NOT_FOUND if chunk is not under_review', async () => {
      // suggestion detection
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // UPDATE returns empty
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(formalVoteService.startCommitPhase('cs-x'))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('commitVote', () => {
    const changesetInCommit = {
      id: 'cs-1',
      vote_phase: 'commit',
      commit_deadline_at: new Date(Date.now() + 86400000), // 24h from now
      proposed_by: 'author-1',
      is_suggestion: false,
    };

    const activeAccount = {
      id: 'voter-1',
      status: 'active',
      first_contribution_at: '2026-01-01T00:00:00Z',
      created_at: '2025-12-01T00:00:00Z', // > 14 days ago
      reputation_contribution: 0.5,
    };

    it('inserts a formal vote with commit hash and weight', async () => {
      const formalVote = { id: 'fv-1', changeset_id: 'cs-1', account_id: 'voter-1', commit_hash: 'abc123', weight: 1.0 };

      mockPool.query
        .mockResolvedValueOnce({ rows: [changesetInCommit] }) // changeset lookup
        .mockResolvedValueOnce({ rows: [activeAccount] }) // account lookup
        .mockResolvedValueOnce({ rows: [formalVote] }) // upsert
        .mockResolvedValueOnce({ rows: [] }); // activity_log

      const result = await formalVoteService.commitVote({
        accountId: 'voter-1',
        changesetId: 'cs-1',
        commitHash: 'abc123',
      });

      expect(result).toEqual(formalVote);
      const upsertSql = mockPool.query.mock.calls[2][0];
      expect(upsertSql).toContain('INSERT INTO formal_votes');
      expect(upsertSql).toContain('ON CONFLICT');
    });

    it('rejects when chunk is not in commit phase', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ ...changesetInCommit, vote_phase: 'reveal' }],
      });

      await expect(formalVoteService.commitVote({
        accountId: 'voter-1',
        changesetId: 'cs-1',
        commitHash: 'abc',
      })).rejects.toMatchObject({ code: 'INVALID_PHASE' });
    });

    it('rejects self-voting (chunk author)', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ ...changesetInCommit, proposed_by: 'voter-1' }],
      });

      await expect(formalVoteService.commitVote({
        accountId: 'voter-1',
        changesetId: 'cs-1',
        commitHash: 'abc',
      })).rejects.toMatchObject({ code: 'SELF_VOTE' });
    });

    it('rejects inactive accounts', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [changesetInCommit] })
        .mockResolvedValueOnce({ rows: [{ ...activeAccount, status: 'provisional' }] });

      await expect(formalVoteService.commitVote({
        accountId: 'voter-1',
        changesetId: 'cs-1',
        commitHash: 'abc',
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rejects accounts without first contribution', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [changesetInCommit] })
        .mockResolvedValueOnce({ rows: [{ ...activeAccount, first_contribution_at: null }] });

      await expect(formalVoteService.commitVote({
        accountId: 'voter-1',
        changesetId: 'cs-1',
        commitHash: 'abc',
      })).rejects.toMatchObject({ code: 'VOTE_LOCKED' });
    });

    it('rejects vote-suspended accounts', async () => {
      isVoteSuspended.mockResolvedValueOnce(true);

      mockPool.query
        .mockResolvedValueOnce({ rows: [changesetInCommit] })
        .mockResolvedValueOnce({ rows: [activeAccount] });

      await expect(formalVoteService.commitVote({
        accountId: 'voter-1',
        changesetId: 'cs-1',
        commitHash: 'abc',
      })).rejects.toMatchObject({ code: 'VOTE_SUSPENDED' });
    });

    it('rejects when commit deadline has passed', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ ...changesetInCommit, commit_deadline_at: new Date(Date.now() - 1000) }],
      });

      await expect(formalVoteService.commitVote({
        accountId: 'voter-1',
        changesetId: 'cs-1',
        commitHash: 'abc',
      })).rejects.toMatchObject({ code: 'DEADLINE_PASSED' });
    });
  });

  describe('revealVote', () => {
    const changesetInReveal = {
      id: 'cs-1',
      vote_phase: 'reveal',
      reveal_deadline_at: new Date(Date.now() + 43200000), // 12h from now
    };

    const salt = 'test-salt-abc';
    const commitHash = hashCommitment(1, 'accurate', salt);

    const committedVote = {
      id: 'fv-1',
      changeset_id: 'cs-1',
      account_id: 'voter-1',
      commit_hash: commitHash,
      revealed_at: null,
    };

    it('reveals a vote with matching hash', async () => {
      const revealedVote = { ...committedVote, vote_value: 1, reason_tag: 'accurate', salt, revealed_at: new Date() };

      mockPool.query
        .mockResolvedValueOnce({ rows: [changesetInReveal] }) // changeset lookup
        .mockResolvedValueOnce({ rows: [committedVote] }) // fetch committed vote
        .mockResolvedValueOnce({ rows: [revealedVote] }) // update
        .mockResolvedValueOnce({ rows: [] }); // activity_log

      const result = await formalVoteService.revealVote({
        accountId: 'voter-1',
        changesetId: 'cs-1',
        voteValue: 1,
        reasonTag: 'accurate',
        salt,
      });

      expect(result.vote_value).toBe(1);
      expect(result.reason_tag).toBe('accurate');
    });

    it('rejects when hash does not match', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [changesetInReveal] })
        .mockResolvedValueOnce({ rows: [committedVote] });

      await expect(formalVoteService.revealVote({
        accountId: 'voter-1',
        changesetId: 'cs-1',
        voteValue: -1, // Different from committed value (1)
        reasonTag: 'accurate',
        salt,
      })).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    });

    it('rejects missing reason_tag', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [changesetInReveal] });

      await expect(formalVoteService.revealVote({
        accountId: 'voter-1',
        changesetId: 'cs-1',
        voteValue: 1,
        reasonTag: null,
        salt,
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects invalid reason_tag', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [changesetInReveal] });

      await expect(formalVoteService.revealVote({
        accountId: 'voter-1',
        changesetId: 'cs-1',
        voteValue: 1,
        reasonTag: 'bogus_tag',
        salt,
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects reveal during commit phase', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ ...changesetInReveal, vote_phase: 'commit' }],
      });

      await expect(formalVoteService.revealVote({
        accountId: 'voter-1',
        changesetId: 'cs-1',
        voteValue: 1,
        reasonTag: 'accurate',
        salt,
      })).rejects.toMatchObject({ code: 'INVALID_PHASE' });
    });

    it('rejects already revealed vote', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [changesetInReveal] })
        .mockResolvedValueOnce({ rows: [{ ...committedVote, revealed_at: new Date() }] });

      await expect(formalVoteService.revealVote({
        accountId: 'voter-1',
        changesetId: 'cs-1',
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
        .mockResolvedValueOnce({ rows: [{ id: 'cs-1', status: 'under_review', vote_phase: 'reveal', proposed_by: 'author-1' }] }) // lock changesets
        .mockResolvedValueOnce({ rows: [] }) // suggestion detection (not a suggestion)
        .mockResolvedValueOnce({ rows: votes }) // fetch revealed votes
        .mockResolvedValueOnce({}) // UPDATE changesets (vote_phase + vote_score)
        .mockResolvedValueOnce({}) // activity log
        .mockResolvedValueOnce({}); // COMMIT

      const result = await formalVoteService.tallyAndResolve('cs-1');

      expect(result.decision).toBe('accept');
      expect(result.score).toBe(3.0);
      expect(result.revealedCount).toBe(3);
    });

    it('rejects chunk when score <= TAU_REJECT', async () => {
      const votes = [
        { vote_value: -1, weight: 1.0 },
        { vote_value: -1, weight: 1.0 },
        { vote_value: -1, weight: 1.0 },
      ];

      mockClient.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'cs-1', status: 'under_review', vote_phase: 'reveal', proposed_by: 'author-1' }] })
        .mockResolvedValueOnce({ rows: [] }) // suggestion detection
        .mockResolvedValueOnce({ rows: votes })
        .mockResolvedValueOnce({}) // UPDATE changesets
        .mockResolvedValueOnce({}) // activity log
        .mockResolvedValueOnce({}); // COMMIT

      const result = await formalVoteService.tallyAndResolve('cs-1');

      expect(result.decision).toBe('reject');
      expect(result.score).toBe(-3.0);
    });

    it('returns indeterminate when between thresholds with quorum', async () => {
      const votes = [
        { vote_value: 1, weight: 0.5 },
        { vote_value: -1, weight: 0.5 },
        { vote_value: 1, weight: 0.3 },
      ];

      mockClient.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'cs-1', status: 'under_review', vote_phase: 'reveal', proposed_by: 'author-1' }] })
        .mockResolvedValueOnce({ rows: [] }) // suggestion detection
        .mockResolvedValueOnce({ rows: votes })
        .mockResolvedValueOnce({}) // UPDATE changesets
        .mockResolvedValueOnce({}) // activity log
        .mockResolvedValueOnce({}); // COMMIT

      const result = await formalVoteService.tallyAndResolve('cs-1');

      expect(result.decision).toBe('indeterminate');
    });

    it('returns no_quorum when below Q_MIN revealed votes', async () => {
      const votes = [
        { vote_value: 1, weight: 1.0 },
        { vote_value: 1, weight: 1.0 },
      ];

      mockClient.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'cs-1', status: 'under_review', vote_phase: 'reveal', proposed_by: 'author-1' }] })
        .mockResolvedValueOnce({ rows: [] }) // suggestion detection
        .mockResolvedValueOnce({ rows: votes })
        .mockResolvedValueOnce({}) // UPDATE changesets
        .mockResolvedValueOnce({}) // activity log
        .mockResolvedValueOnce({}); // COMMIT

      const result = await formalVoteService.tallyAndResolve('cs-1');

      expect(result.decision).toBe('no_quorum');
    });

    it('returns null if chunk already resolved (skip locked)', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }); // SKIP LOCKED → nothing found

      const result = await formalVoteService.tallyAndResolve('cs-1');

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
        .mockResolvedValueOnce({ rows: [{ id: 'cs-1', status: 'under_review', vote_phase: 'reveal', proposed_by: 'author-1' }] })
        .mockResolvedValueOnce({ rows: [] }) // suggestion detection
        .mockResolvedValueOnce({ rows: votes })
        .mockResolvedValueOnce({}) // UPDATE
        .mockResolvedValueOnce({}) // activity log
        .mockResolvedValueOnce({}); // COMMIT

      await formalVoteService.tallyAndResolve('cs-1');

      // Allow fire-and-forget to complete
      await new Promise(r => setTimeout(r, 50));

      expect(reputationService.recalculateChunkTrust).toHaveBeenCalledWith('cs-1');
    });
  });

  describe('getVoteStatus', () => {
    it('returns hidden results during commit phase', async () => {
      const deadline = new Date(Date.now() + 86400000);
      mockPool.query
        .mockResolvedValueOnce({
          rows: [{ id: 'cs-1', status: 'under_review', vote_phase: 'commit', commit_deadline_at: deadline, reveal_deadline_at: deadline, vote_score: null }],
        })
        .mockResolvedValueOnce({ rows: [] }) // suggestion detection
        .mockResolvedValueOnce({ rows: [{ commit_count: 2, revealed_count: 0 }] })
        .mockResolvedValueOnce({ rows: [] }); // my vote check

      const result = await formalVoteService.getVoteStatus('cs-1', 'viewer-1');

      expect(result.phase).toBe('commit');
      expect(result.status).toBe('voting_in_progress');
      expect(result.results).toBe('hidden');
      expect(result.commitCount).toBe(2);
    });

    it('returns hidden results during reveal phase', async () => {
      const deadline = new Date(Date.now() + 43200000);
      mockPool.query
        .mockResolvedValueOnce({
          rows: [{ id: 'cs-1', status: 'under_review', vote_phase: 'reveal', commit_deadline_at: deadline, reveal_deadline_at: deadline, vote_score: null }],
        })
        .mockResolvedValueOnce({ rows: [] }) // suggestion detection
        .mockResolvedValueOnce({ rows: [{ commit_count: 3, revealed_count: 1 }] })
        .mockResolvedValueOnce({ rows: [{ revealed_at: null }] }); // committed but not revealed

      const result = await formalVoteService.getVoteStatus('cs-1', 'voter-1');

      expect(result.phase).toBe('reveal');
      expect(result.results).toBe('hidden');
      expect(result.hasCommitted).toBe(true);
      expect(result.hasRevealed).toBe(false);
    });

    it('returns full results when resolved', async () => {
      mockPool.query
        .mockResolvedValueOnce({
          rows: [{ id: 'cs-1', status: 'published', vote_phase: 'resolved', commit_deadline_at: new Date(), reveal_deadline_at: new Date(), vote_score: 2.5 }],
        })
        .mockResolvedValueOnce({ rows: [] }) // suggestion detection
        .mockResolvedValueOnce({ rows: [{ commit_count: 3, revealed_count: 3 }] })
        // No my-vote query when requestingAccountId is null
        .mockResolvedValueOnce({ rows: [
          { account_id: 'v1', vote_value: 1, reason_tag: 'accurate', weight: 1.0, revealed_at: new Date(), voter_name: 'Agent A' },
        ] });

      const result = await formalVoteService.getVoteStatus('cs-1', null);

      expect(result.phase).toBe('resolved');
      expect(result.status).toBe('decided');
      expect(result.score).toBe(2.5);
      expect(result.votes).toHaveLength(1);
      expect(result.votes[0].voteValue).toBe(1);
    });

    it('returns null phase when no formal vote active', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'cs-1', status: 'proposed', vote_phase: null, commit_deadline_at: null, reveal_deadline_at: null, vote_score: null }],
      });

      const result = await formalVoteService.getVoteStatus('cs-1', null);

      expect(result.phase).toBeNull();
    });
  });

  describe('activity_log emissions (archetype instrumentation)', () => {
    const changesetInCommit = {
      id: 'cs-1',
      vote_phase: 'commit',
      commit_deadline_at: new Date(Date.now() + 86400000),
      proposed_by: 'author-1',
      is_suggestion: false,
    };
    const activeAccount = {
      id: 'voter-1',
      status: 'active',
      first_contribution_at: '2026-01-01T00:00:00Z',
      created_at: '2025-12-01T00:00:00Z',
      reputation_contribution: 0.5,
    };

    it('commitVote emits vote_committed activity entry', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [changesetInCommit] })
        .mockResolvedValueOnce({ rows: [activeAccount] })
        .mockResolvedValueOnce({ rows: [{ id: 'fv-1' }] }) // upsert
        .mockResolvedValueOnce({ rows: [] }); // activity_log

      await formalVoteService.commitVote({
        accountId: 'voter-1',
        changesetId: 'cs-1',
        commitHash: 'abc123',
      });

      const activityCall = mockPool.query.mock.calls.find(c => /INSERT INTO activity_log/.test(c[0]));
      expect(activityCall).toBeDefined();
      expect(activityCall[0]).toMatch(/'vote_committed'/);
      expect(activityCall[0]).toMatch(/'changeset'/);
      expect(activityCall[1]).toEqual(['voter-1', 'cs-1']);
    });

    it('revealVote emits vote_revealed activity entry', async () => {
      const salt = 'test-salt-xyz';
      const commitHash = hashCommitment(1, 'accurate', salt);
      const committedVote = {
        id: 'fv-1',
        changeset_id: 'cs-1',
        account_id: 'voter-1',
        commit_hash: commitHash,
        revealed_at: null,
      };
      const changesetInReveal = {
        id: 'cs-1',
        vote_phase: 'reveal',
        reveal_deadline_at: new Date(Date.now() + 43200000),
      };

      mockPool.query
        .mockResolvedValueOnce({ rows: [changesetInReveal] })
        .mockResolvedValueOnce({ rows: [committedVote] })
        .mockResolvedValueOnce({ rows: [{ ...committedVote, vote_value: 1, revealed_at: new Date() }] })
        .mockResolvedValueOnce({ rows: [] }); // activity_log

      await formalVoteService.revealVote({
        accountId: 'voter-1',
        changesetId: 'cs-1',
        voteValue: 1,
        reasonTag: 'accurate',
        salt,
      });

      const activityCall = mockPool.query.mock.calls.find(c => /INSERT INTO activity_log/.test(c[0]));
      expect(activityCall).toBeDefined();
      expect(activityCall[0]).toMatch(/'vote_revealed'/);
      expect(activityCall[0]).toMatch(/'changeset'/);
      expect(activityCall[1]).toEqual(['voter-1', 'cs-1']);
      // Ensure no vote_value/reason_tag leak into the audit log
      expect(activityCall[0]).not.toMatch(/vote_value|reason_tag/);
    });
  });
});
