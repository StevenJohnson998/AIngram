jest.mock('../../config/database');

const { getPool } = require('../../config/database');
const reputationService = require('../reputation');

describe('reputation service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPool = {
      query: jest.fn(),
    };

    getPool.mockReturnValue(mockPool);
  });

  describe('recalculateReputation', () => {
    it('calculates positive reputation when all votes are up', async () => {
      // Contribution query: all up votes
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ up_weight: 5.0, down_weight: 0, total_weight: 5.0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 3.0, down_weight: 0, total_weight: 3.0 }] })
        .mockResolvedValueOnce({ rowCount: 1 }); // update

      const result = await reputationService.recalculateReputation('acc-1');

      expect(result.reputationContribution).toBe(1.0);
      expect(result.reputationPolicing).toBe(1.0);
    });

    it('calculates negative reputation when all votes are down', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, down_weight: 4.0, total_weight: 4.0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, down_weight: 2.0, total_weight: 2.0 }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.recalculateReputation('acc-1');

      expect(result.reputationContribution).toBe(-1.0);
      expect(result.reputationPolicing).toBe(-1.0);
    });

    it('calculates mixed reputation correctly', async () => {
      // 3 up (weight 3.0), 1 down (weight 1.0) = (3-1)/4 = 0.5
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ up_weight: 3.0, down_weight: 1.0, total_weight: 4.0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 2.0, down_weight: 2.0, total_weight: 4.0 }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.recalculateReputation('acc-1');

      expect(result.reputationContribution).toBe(0.5);
      expect(result.reputationPolicing).toBe(0); // 2-2 / 4 = 0
    });

    it('returns 0 reputation when no votes exist', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, down_weight: 0, total_weight: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, down_weight: 0, total_weight: 0 }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.recalculateReputation('acc-1');

      expect(result.reputationContribution).toBe(0);
      expect(result.reputationPolicing).toBe(0);
    });

    it('updates the accounts table with calculated values', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ up_weight: 8.0, down_weight: 2.0, total_weight: 10.0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 1.0, down_weight: 1.0, total_weight: 2.0 }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      await reputationService.recalculateReputation('acc-1');

      const updateCall = mockPool.query.mock.calls[2];
      expect(updateCall[0]).toContain('UPDATE accounts');
      expect(updateCall[1]).toEqual([0.6, 0, 'acc-1']); // (8-2)/10=0.6, (1-1)/2=0
    });
  });

  describe('checkBadges', () => {
    const oldAccount = {
      id: 'acc-1',
      created_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(), // 60 days ago
    };

    it('grants both badges when all criteria met', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [oldAccount] }) // account lookup
        .mockResolvedValueOnce({ rows: [{ flag_count: 0 }] }) // no flags
        .mockResolvedValueOnce({ rows: [{ up_weight: 9.0, total_weight: 10.0 }] }) // 90% positive contrib
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] }) // 5 topics contrib
        .mockResolvedValueOnce({ rows: [{ up_weight: 9.0, total_weight: 10.0 }] }) // 90% positive policing
        .mockResolvedValueOnce({ rows: [{ topic_count: 3 }] }) // 3 topics policing
        .mockResolvedValueOnce({ rowCount: 1 }); // update

      const result = await reputationService.checkBadges('acc-1');

      expect(result.badgeContribution).toBe(true);
      expect(result.badgePolicing).toBe(true);
    });

    it('denies badges when account is too recent', async () => {
      const newAccount = {
        id: 'acc-1',
        created_at: new Date().toISOString(), // just created
      };

      mockPool.query
        .mockResolvedValueOnce({ rows: [newAccount] })
        .mockResolvedValueOnce({ rows: [{ flag_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 10.0, total_weight: 10.0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 10.0, total_weight: 10.0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.checkBadges('acc-1');

      expect(result.badgeContribution).toBe(false);
      expect(result.badgePolicing).toBe(false);
    });

    it('denies badges when insufficient topics', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [oldAccount] })
        .mockResolvedValueOnce({ rows: [{ flag_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 10.0, total_weight: 10.0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 2 }] }) // only 2 topics
        .mockResolvedValueOnce({ rows: [{ up_weight: 10.0, total_weight: 10.0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 1 }] }) // only 1 topic
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.checkBadges('acc-1');

      expect(result.badgeContribution).toBe(false);
      expect(result.badgePolicing).toBe(false);
    });

    it('denies badges when positive ratio is below 85%', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [oldAccount] })
        .mockResolvedValueOnce({ rows: [{ flag_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 8.0, total_weight: 10.0 }] }) // 80% < 85%
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 8.0, total_weight: 10.0 }] }) // 80%
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.checkBadges('acc-1');

      expect(result.badgeContribution).toBe(false);
      expect(result.badgePolicing).toBe(false);
    });

    it('denies badges when account has active flags', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [oldAccount] })
        .mockResolvedValueOnce({ rows: [{ flag_count: 2 }] }) // has flags
        .mockResolvedValueOnce({ rows: [{ up_weight: 10.0, total_weight: 10.0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 10.0, total_weight: 10.0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.checkBadges('acc-1');

      expect(result.badgeContribution).toBe(false);
      expect(result.badgePolicing).toBe(false);
    });

    it('handles edge case: no votes returns no badges (0 positive ratio)', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [oldAccount] })
        .mockResolvedValueOnce({ rows: [{ flag_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, total_weight: 0 }] }) // no votes
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, total_weight: 0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.checkBadges('acc-1');

      expect(result.badgeContribution).toBe(false);
      expect(result.badgePolicing).toBe(false);
    });
  });

  describe('getReputationDetails', () => {
    it('returns structured reputation details', async () => {
      mockPool.query
        .mockResolvedValueOnce({
          rows: [{
            reputation_contribution: 0.75,
            reputation_policing: 0.5,
            badge_contribution: true,
            badge_policing: false,
          }],
        })
        .mockResolvedValueOnce({ rows: [{ vote_count: 20 }] }) // contrib vote count
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] }) // contrib topic count
        .mockResolvedValueOnce({ rows: [{ vote_count: 8 }] }); // policing vote count

      const result = await reputationService.getReputationDetails('acc-1');

      expect(result).toEqual({
        contribution: { score: 0.75, voteCount: 20, topicCount: 5 },
        policing: { score: 0.5, voteCount: 8 },
        badges: { contribution: true, policing: false },
      });
    });

    it('throws NOT_FOUND when account does not exist', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        reputationService.getReputationDetails('nonexistent')
      ).rejects.toThrow('Account not found');
    });

    it('returns 0 scores when reputation is null', async () => {
      mockPool.query
        .mockResolvedValueOnce({
          rows: [{
            reputation_contribution: null,
            reputation_policing: null,
            badge_contribution: null,
            badge_policing: null,
          }],
        })
        .mockResolvedValueOnce({ rows: [{ vote_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ vote_count: 0 }] });

      const result = await reputationService.getReputationDetails('acc-1');

      expect(result.contribution.score).toBe(0);
      expect(result.policing.score).toBe(0);
      expect(result.badges.contribution).toBe(false);
      expect(result.badges.policing).toBe(false);
    });
  });

  describe('recalculateAll', () => {
    it('processes all active accounts', async () => {
      // List active accounts
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'acc-1' }, { id: 'acc-2' }],
      });

      // For each account: recalculateReputation (3 queries) + checkBadges (7 queries) = 10 queries each
      // acc-1 recalculate
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ up_weight: 5, down_weight: 0, total_weight: 5 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, down_weight: 0, total_weight: 0 }] })
        .mockResolvedValueOnce({ rowCount: 1 });
      // acc-1 checkBadges
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'acc-1', created_at: '2025-01-01' }] })
        .mockResolvedValueOnce({ rows: [{ flag_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 5, total_weight: 5 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 4 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, total_weight: 0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 0 }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      // acc-2 recalculate
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, down_weight: 0, total_weight: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, down_weight: 0, total_weight: 0 }] })
        .mockResolvedValueOnce({ rowCount: 1 });
      // acc-2 checkBadges
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'acc-2', created_at: '2025-01-01' }] })
        .mockResolvedValueOnce({ rows: [{ flag_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, total_weight: 0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, total_weight: 0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 0 }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const results = await reputationService.recalculateAll();

      expect(results).toHaveLength(2);
      expect(results[0].accountId).toBe('acc-1');
      expect(results[1].accountId).toBe('acc-2');
    });
  });
});
