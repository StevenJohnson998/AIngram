jest.mock('../../config/database');
jest.mock('../../config/trust', () => ({
  REP_PRIOR_ALPHA: 1,
  REP_PRIOR_BETA: 1,
  BADGE_MIN_AGE_DAYS: 30,
  BADGE_ELITE_MIN_AGE_DAYS: 90,
  BADGE_MIN_POSITIVE_RATIO: 0.85,
  BADGE_CONTRIBUTION_MIN_TOPICS: 3,
  BADGE_POLICING_MIN_TOPICS: 3,
  BADGE_ELITE_MIN_TOPICS: 10,
  BADGE_ELITE_MIN_REPUTATION: 0.9,
  CHUNK_PRIOR_NEW: [1, 1],
  CHUNK_PRIOR_ESTABLISHED: [3, 1],
  CHUNK_PRIOR_ELITE: [5, 1],
  SOURCE_BONUS_PER_SOURCE: 0.75,
  SOURCE_BONUS_CAP: 3.0,
  AGE_HALF_LIFE_DAYS: 180,
  AGE_DECAY_FLOOR: 0.3,
  VOTER_REP_BASE: 0.5,
}));

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

  describe('recalculateReputation (Beta formula)', () => {
    // Beta: rep = (prior_α + up) / (prior_α + up + prior_β + down)
    // With priors [1, 1]: rep = (1 + up) / (2 + up + down)

    it('calculates high reputation when all votes are up', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ up_weight: 5.0, down_weight: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 3.0, down_weight: 0 }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.recalculateReputation('acc-1');

      // (1+5)/(1+5+1+0) = 6/7 ≈ 0.857
      expect(result.reputationContribution).toBeCloseTo(6 / 7, 5);
      // (1+3)/(1+3+1+0) = 4/5 = 0.8
      expect(result.reputationPolicing).toBeCloseTo(4 / 5, 5);
    });

    it('calculates low reputation when all votes are down', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, down_weight: 4.0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, down_weight: 2.0 }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.recalculateReputation('acc-1');

      // (1+0)/(1+0+1+4) = 1/6 ≈ 0.167
      expect(result.reputationContribution).toBeCloseTo(1 / 6, 5);
      // (1+0)/(1+0+1+2) = 1/4 = 0.25
      expect(result.reputationPolicing).toBeCloseTo(1 / 4, 5);
    });

    it('calculates mixed reputation correctly', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ up_weight: 3.0, down_weight: 1.0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 2.0, down_weight: 2.0 }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.recalculateReputation('acc-1');

      // (1+3)/(1+3+1+1) = 4/6 ≈ 0.667
      expect(result.reputationContribution).toBeCloseTo(4 / 6, 5);
      // (1+2)/(1+2+1+2) = 3/6 = 0.5
      expect(result.reputationPolicing).toBeCloseTo(3 / 6, 5);
    });

    it('returns 0.5 (neutral prior) when no votes exist', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, down_weight: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, down_weight: 0 }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.recalculateReputation('acc-1');

      // (1+0)/(1+0+1+0) = 1/2 = 0.5 (uninformative prior, not zero)
      expect(result.reputationContribution).toBe(0.5);
      expect(result.reputationPolicing).toBe(0.5);
    });

    it('updates the accounts table with Beta values', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ up_weight: 8.0, down_weight: 2.0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 1.0, down_weight: 1.0 }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      await reputationService.recalculateReputation('acc-1');

      const updateCall = mockPool.query.mock.calls[2];
      expect(updateCall[0]).toContain('UPDATE accounts');
      // contribution: (1+8)/(1+8+1+2) = 9/12 = 0.75
      // policing: (1+1)/(1+1+1+1) = 2/4 = 0.5
      expect(updateCall[1][0]).toBeCloseTo(0.75, 5);
      expect(updateCall[1][1]).toBeCloseTo(0.5, 5);
      expect(updateCall[1][2]).toBe('acc-1');
    });
  });

  describe('checkBadges', () => {
    const oldAccount = {
      id: 'acc-1',
      created_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    };

    it('grants both badges when all criteria met', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [oldAccount] })
        .mockResolvedValueOnce({ rows: [{ flag_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 9.0, total_weight: 10.0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 9.0, total_weight: 10.0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 3 }] })
        .mockResolvedValueOnce({ rows: [{ reputation_contribution: 0.8, badge_contribution: true }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.checkBadges('acc-1');

      expect(result.badgeContribution).toBe(true);
      expect(result.badgePolicing).toBe(true);
    });

    it('denies badges when account is too recent', async () => {
      const newAccount = {
        id: 'acc-1',
        created_at: new Date().toISOString(),
      };

      mockPool.query
        .mockResolvedValueOnce({ rows: [newAccount] })
        .mockResolvedValueOnce({ rows: [{ flag_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 10.0, total_weight: 10.0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 10.0, total_weight: 10.0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rows: [{ reputation_contribution: 0, badge_contribution: false }] })
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
        .mockResolvedValueOnce({ rows: [{ topic_count: 2 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 10.0, total_weight: 10.0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 1 }] })
        .mockResolvedValueOnce({ rows: [{ reputation_contribution: 0, badge_contribution: false }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.checkBadges('acc-1');

      expect(result.badgeContribution).toBe(false);
      expect(result.badgePolicing).toBe(false);
    });

    it('denies badges when positive ratio is below 85%', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [oldAccount] })
        .mockResolvedValueOnce({ rows: [{ flag_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 8.0, total_weight: 10.0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 8.0, total_weight: 10.0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rows: [{ reputation_contribution: 0, badge_contribution: false }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.checkBadges('acc-1');

      expect(result.badgeContribution).toBe(false);
      expect(result.badgePolicing).toBe(false);
    });

    it('denies badges when account has active flags', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [oldAccount] })
        .mockResolvedValueOnce({ rows: [{ flag_count: 2 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 10.0, total_weight: 10.0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 10.0, total_weight: 10.0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rows: [{ reputation_contribution: 0, badge_contribution: false }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.checkBadges('acc-1');

      expect(result.badgeContribution).toBe(false);
      expect(result.badgePolicing).toBe(false);
    });

    it('handles edge case: no votes returns no badges', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [oldAccount] })
        .mockResolvedValueOnce({ rows: [{ flag_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, total_weight: 0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, total_weight: 0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rows: [{ reputation_contribution: 0, badge_contribution: false }] })
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
            badge_elite: false,
          }],
        })
        .mockResolvedValueOnce({ rows: [{ vote_count: 20 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 5 }] })
        .mockResolvedValueOnce({ rows: [{ vote_count: 8 }] });

      const result = await reputationService.getReputationDetails('acc-1');

      expect(result).toEqual({
        contribution: { score: 0.75, voteCount: 20, topicCount: 5 },
        policing: { score: 0.5, voteCount: 8 },
        badges: { contribution: true, policing: false, elite: false },
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
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'acc-1' }, { id: 'acc-2' }],
      });

      // acc-1 recalculate (2 queries + update)
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ up_weight: 5, down_weight: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, down_weight: 0 }] })
        .mockResolvedValueOnce({ rowCount: 1 });
      // acc-1 checkBadges (8 queries)
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'acc-1', created_at: '2025-01-01' }] })
        .mockResolvedValueOnce({ rows: [{ flag_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 5, total_weight: 5 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 4 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, total_weight: 0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ reputation_contribution: 0, badge_contribution: false }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      // acc-2 recalculate
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, down_weight: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, down_weight: 0 }] })
        .mockResolvedValueOnce({ rowCount: 1 });
      // acc-2 checkBadges
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'acc-2', created_at: '2025-01-01' }] })
        .mockResolvedValueOnce({ rows: [{ flag_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, total_weight: 0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ up_weight: 0, total_weight: 0 }] })
        .mockResolvedValueOnce({ rows: [{ topic_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ reputation_contribution: 0, badge_contribution: false }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const results = await reputationService.recalculateAll();

      expect(results).toHaveLength(2);
      expect(results[0].accountId).toBe('acc-1');
      expect(results[1].accountId).toBe('acc-2');
    });
  });
});
