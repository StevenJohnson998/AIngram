jest.mock('../../config/database');
jest.mock('../../config/trust', () => ({
  VOTE_WEIGHT_NO_CONTRIBUTION: 0.1,
  VOTE_WEIGHT_NEW_ACCOUNT: 0.5,
  VOTE_WEIGHT_ESTABLISHED: 1.0,
  NEW_ACCOUNT_THRESHOLD_DAYS: 14,
  VOTER_REP_BASE: 0.5,
}));
jest.mock('../reputation', () => ({
  recalculateReputation: jest.fn().mockResolvedValue({}),
  recalculateChunkTrust: jest.fn().mockResolvedValue(0.5),
  checkBadges: jest.fn().mockResolvedValue({}),
}));
jest.mock('../account', () => ({
  incrementInteractionAndUpdateTier: jest.fn().mockResolvedValue({}),
}));
jest.mock('../sanction', () => ({
  isVoteSuspended: jest.fn().mockResolvedValue(false),
}));

const { getPool } = require('../../config/database');
const voteService = require('../vote');
const { recalculateReputation, recalculateChunkTrust, checkBadges } = require('../reputation');
const accountService = require('../account');
const { isVoteSuspended } = require('../sanction');

describe('vote service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPool = {
      query: jest.fn(),
    };

    getPool.mockReturnValue(mockPool);
  });

  describe('castVote', () => {
    const activeAccount = {
      id: 'acc-1',
      status: 'active',
      type: 'ai',
      first_contribution_at: '2026-01-01T00:00:00Z',
      created_at: '2025-12-01T00:00:00Z', // > 14 days ago
    };

    it('casts a vote with EigenTrust-weighted weight for established accounts', async () => {
      // base=1.0 (old account) * repFactor=(0.5+0.5)=1.0 → weight=1.0
      const vote = { id: 'vote-1', account_id: 'acc-1', value: 'up', weight: 1.0 };

      mockPool.query
        .mockResolvedValueOnce({ rows: [activeAccount] }) // account lookup
        .mockResolvedValueOnce({ rows: [{ account_id: 'acc-other', status: 'active' }] }) // message check
        .mockResolvedValueOnce({ rows: [{ rep: 0.5 }] }) // voter reputation (EigenTrust)
        .mockResolvedValueOnce({ rows: [vote] }); // upsert

      const result = await voteService.castVote({
        accountId: 'acc-1',
        targetType: 'message',
        targetId: 'msg-1',
        value: 'up',
        reasonTag: 'accurate',
      });

      expect(result).toEqual(vote);
      const upsertCall = mockPool.query.mock.calls[3];
      expect(upsertCall[0]).toContain('ON CONFLICT');
      // weight = base(1.0) * (0.5 + 0.5) = 1.0
      expect(upsertCall[1]).toEqual(['acc-1', 'message', 'msg-1', 'up', 'accurate', 1.0]);
    });

    it('assigns dampened weight for new accounts', async () => {
      // base=0.5 (new account) * repFactor=(0.5+0.5)=1.0 → weight=0.5
      const newAccount = {
        ...activeAccount,
        created_at: new Date().toISOString(),
      };

      mockPool.query
        .mockResolvedValueOnce({ rows: [newAccount] })
        .mockResolvedValueOnce({ rows: [{ account_id: 'acc-other', status: 'active' }] })
        .mockResolvedValueOnce({ rows: [{ rep: 0.5 }] }) // voter reputation
        .mockResolvedValueOnce({ rows: [{ id: 'vote-1', weight: 0.5 }] });

      await voteService.castVote({
        accountId: 'acc-1',
        targetType: 'message',
        targetId: 'msg-1',
        value: 'up',
      });

      const upsertCall = mockPool.query.mock.calls[3];
      expect(upsertCall[1][5]).toBe(0.5); // weight = 0.5 * (0.5+0.5) = 0.5
    });

    it('assigns minimal weight (0.1) for agents without contribution', async () => {
      const noContribAgent = { ...activeAccount, first_contribution_at: null };

      mockPool.query
        .mockResolvedValueOnce({ rows: [noContribAgent] })       // account lookup
        .mockResolvedValueOnce({ rows: [{ account_id: 'acc-other', status: 'active' }] }) // message check
        .mockResolvedValueOnce({ rows: [{ rep: 0.5 }] })        // reputation
        .mockResolvedValueOnce({ rows: [{ id: 'vote-1', weight: 0.1 }] }); // upsert

      await voteService.castVote({
        accountId: 'acc-1',
        targetType: 'message',
        targetId: 'msg-1',
        value: 'up',
      });

      const upsertCall = mockPool.query.mock.calls[3];
      // weight = 0.1 * (0.5 + 0.5) = 0.1
      expect(upsertCall[1][5]).toBeCloseTo(0.1);
    });

    it('assigns full weight (1.0) for humans even without contribution', async () => {
      const humanNoContrib = { ...activeAccount, type: 'human', first_contribution_at: null };

      mockPool.query
        .mockResolvedValueOnce({ rows: [humanNoContrib] })       // account lookup
        .mockResolvedValueOnce({ rows: [{ account_id: 'acc-other', status: 'active' }] }) // message check
        .mockResolvedValueOnce({ rows: [{ rep: 0.5 }] })        // reputation
        .mockResolvedValueOnce({ rows: [{ id: 'vote-1', weight: 1.0 }] }); // upsert

      await voteService.castVote({
        accountId: 'acc-1',
        targetType: 'message',
        targetId: 'msg-1',
        value: 'up',
      });

      const upsertCall = mockPool.query.mock.calls[3];
      // weight = 1.0 * (0.5 + 0.5) = 1.0
      expect(upsertCall[1][5]).toBe(1.0);
    });

    it('rejects vote from provisional accounts', async () => {
      const provisionalAccount = { ...activeAccount, status: 'provisional' };

      mockPool.query.mockResolvedValueOnce({ rows: [provisionalAccount] });

      await expect(
        voteService.castVote({
          accountId: 'acc-1',
          targetType: 'message',
          targetId: 'msg-1',
          value: 'up',
        })
      ).rejects.toThrow('Only active accounts can vote');
    });

    it('upserts when voting again on same target (change vote value)', async () => {
      const vote = { id: 'vote-1', value: 'down', weight: 1.0 };

      mockPool.query
        .mockResolvedValueOnce({ rows: [activeAccount] })
        .mockResolvedValueOnce({ rows: [{ account_id: 'acc-other', status: 'active' }] })
        .mockResolvedValueOnce({ rows: [{ rep: 0.5 }] }) // voter reputation
        .mockResolvedValueOnce({ rows: [vote] });

      const result = await voteService.castVote({
        accountId: 'acc-1',
        targetType: 'message',
        targetId: 'msg-1',
        value: 'down',
      });

      expect(result.value).toBe('down');
      const upsertQuery = mockPool.query.mock.calls[3][0];
      expect(upsertQuery).toContain('ON CONFLICT');
      expect(upsertQuery).toContain('DO UPDATE');
    });

    it('blocks self-voting on own message', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [activeAccount] })
        .mockResolvedValueOnce({ rows: [{ account_id: 'acc-1', status: 'active' }] }); // same account

      try {
        await voteService.castVote({
          accountId: 'acc-1',
          targetType: 'message',
          targetId: 'msg-1',
          value: 'up',
        });
        throw new Error('Should have thrown');
      } catch (err) {
        expect(err.message).toBe('Cannot vote on own content');
        expect(err.code).toBe('SELF_VOTE');
      }
    });

    it('blocks voting on retracted content', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [activeAccount] })
        .mockResolvedValueOnce({ rows: [{ account_id: 'acc-other', status: 'retracted' }] });

      await expect(
        voteService.castVote({
          accountId: 'acc-1',
          targetType: 'message',
          targetId: 'msg-1',
          value: 'up',
        })
      ).rejects.toThrow('Cannot vote on retracted content');
    });

    it('rejects invalid reason_tag for message target', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [activeAccount] });

      await expect(
        voteService.castVote({
          accountId: 'acc-1',
          targetType: 'message',
          targetId: 'msg-1',
          value: 'up',
          reasonTag: 'fair', // policing-only tag
        })
      ).rejects.toThrow("Invalid reason_tag 'fair' for target_type 'message'");
    });

    it('rejects invalid reason_tag for policing_action target', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [activeAccount] });

      await expect(
        voteService.castVote({
          accountId: 'acc-1',
          targetType: 'policing_action',
          targetId: 'msg-1',
          value: 'up',
          reasonTag: 'accurate', // content-only tag
        })
      ).rejects.toThrow("Invalid reason_tag 'accurate' for target_type 'policing_action'");
    });

    it('calls recalculateChunkTrust after voting on a chunk', async () => {
      const vote = { id: 'vote-1', value: 'up', weight: 1.0 };

      mockPool.query
        .mockResolvedValueOnce({ rows: [activeAccount] }) // account lookup
        .mockResolvedValueOnce({ rows: [{ created_by: 'acc-author', status: 'published' }] }) // chunk check
        .mockResolvedValueOnce({ rows: [{ rep: 0.5 }] }) // voter reputation
        .mockResolvedValueOnce({ rows: [vote] }) // upsert
        .mockResolvedValueOnce({ rows: [{ created_by: 'acc-author' }] }); // fire-and-forget author lookup

      await voteService.castVote({
        accountId: 'acc-1',
        targetType: 'chunk',
        targetId: 'chunk-1',
        value: 'up',
      });

      // Allow fire-and-forget to complete
      await new Promise(r => setTimeout(r, 50));

      expect(recalculateChunkTrust).toHaveBeenCalledWith('chunk-1');
    });

    it('calls checkBadges for the target author after voting', async () => {
      const vote = { id: 'vote-1', value: 'up', weight: 1.0 };

      mockPool.query
        .mockResolvedValueOnce({ rows: [activeAccount] }) // account lookup
        .mockResolvedValueOnce({ rows: [{ account_id: 'acc-author', status: 'active' }] }) // message check
        .mockResolvedValueOnce({ rows: [{ rep: 0.5 }] }) // voter reputation
        .mockResolvedValueOnce({ rows: [vote] }) // upsert
        .mockResolvedValueOnce({ rows: [{ account_id: 'acc-author' }] }); // fire-and-forget author lookup

      await voteService.castVote({
        accountId: 'acc-1',
        targetType: 'message',
        targetId: 'msg-1',
        value: 'up',
      });

      await new Promise(r => setTimeout(r, 50));

      expect(recalculateReputation).toHaveBeenCalledWith('acc-author');
      expect(checkBadges).toHaveBeenCalledWith('acc-author');
    });

    it('rejects vote when account has active vote suspension', async () => {
      isVoteSuspended.mockResolvedValueOnce(true);

      mockPool.query
        .mockResolvedValueOnce({ rows: [activeAccount] }); // account lookup

      await expect(
        voteService.castVote({
          accountId: 'acc-1',
          targetType: 'message',
          targetId: 'msg-1',
          value: 'up',
        })
      ).rejects.toThrow('Account has an active vote suspension');
    });

    it('does not call recalculateChunkTrust for non-chunk votes', async () => {
      const vote = { id: 'vote-1', value: 'up', weight: 1.0 };

      mockPool.query
        .mockResolvedValueOnce({ rows: [activeAccount] })
        .mockResolvedValueOnce({ rows: [{ account_id: 'acc-author', status: 'active' }] })
        .mockResolvedValueOnce({ rows: [{ rep: 0.5 }] })
        .mockResolvedValueOnce({ rows: [vote] })
        .mockResolvedValueOnce({ rows: [{ account_id: 'acc-author' }] });

      await voteService.castVote({
        accountId: 'acc-1',
        targetType: 'message',
        targetId: 'msg-1',
        value: 'up',
      });

      await new Promise(r => setTimeout(r, 50));

      expect(recalculateChunkTrust).not.toHaveBeenCalled();
    });
  });

  describe('removeVote', () => {
    it('returns true when vote is deleted', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

      const result = await voteService.removeVote('acc-1', 'message', 'msg-1');
      expect(result).toBe(true);
    });

    it('returns false when vote does not exist', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 0 });

      const result = await voteService.removeVote('acc-1', 'message', 'msg-1');
      expect(result).toBe(false);
    });

    it('calls recalculateChunkTrust after removing a chunk vote', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

      await voteService.removeVote('acc-1', 'chunk', 'chunk-1');

      await new Promise(r => setTimeout(r, 50));

      expect(recalculateChunkTrust).toHaveBeenCalledWith('chunk-1');
    });

    it('does not call recalculateChunkTrust when removing a non-chunk vote', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

      await voteService.removeVote('acc-1', 'message', 'msg-1');

      await new Promise(r => setTimeout(r, 50));

      expect(recalculateChunkTrust).not.toHaveBeenCalled();
    });

    it('does not call recalculateChunkTrust when vote does not exist', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 0 });

      await voteService.removeVote('acc-1', 'chunk', 'chunk-1');

      await new Promise(r => setTimeout(r, 50));

      expect(recalculateChunkTrust).not.toHaveBeenCalled();
    });
  });

  describe('getVotesByTarget', () => {
    it('returns paginated votes for a target', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 25 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'v1' }, { id: 'v2' }] });

      const result = await voteService.getVotesByTarget('message', 'msg-1', { page: 1, limit: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({ page: 1, limit: 2, total: 25 });
    });
  });

  describe('getVotesByAccount', () => {
    it('returns paginated votes for an account', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 10 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'v1' }] });

      const result = await voteService.getVotesByAccount('acc-1', { page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(10);
    });
  });

  describe('getVoteSummary', () => {
    it('returns correct summary with up and down counts and weights', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          upCount: 5,
          downCount: 2,
          upWeight: 4.5,
          downWeight: 2.0,
          total: 7,
        }],
      });

      const result = await voteService.getVoteSummary('message', 'msg-1');

      expect(result.upCount).toBe(5);
      expect(result.downCount).toBe(2);
      expect(result.upWeight).toBe(4.5);
      expect(result.downWeight).toBe(2.0);
      expect(result.total).toBe(7);
    });
  });
});
