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
      reputation_contribution: 0.9,
      badge_contribution: true,
    };

    // Helper: checkBadges now uses 3 parallel queries + 1 UPDATE.
    // Mock routes by SQL content since Promise.all order is non-deterministic.
    function setupBadgeMocks(account, flagCount, levelStats) {
      mockPool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('reputation_contribution')) {
          return Promise.resolve({ rows: [account] });
        }
        if (typeof sql === 'string' && sql.includes('flag_count')) {
          return Promise.resolve({ rows: [{ flag_count: flagCount }] });
        }
        if (typeof sql === 'string' && sql.includes('m.level IN')) {
          return Promise.resolve({ rows: levelStats });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE accounts SET badge_')) {
          return Promise.resolve({ rowCount: 1 });
        }
        return Promise.resolve({ rows: [] });
      });
    }

    it('grants both badges when all criteria met', async () => {
      setupBadgeMocks(oldAccount, 0, [
        { level: 1, topic_count: 5, up_weight: 9.0, total_weight: 10.0 },
        { level: 2, topic_count: 3, up_weight: 9.0, total_weight: 10.0 },
      ]);

      const result = await reputationService.checkBadges('acc-1');

      expect(result.badgeContribution).toBe(true);
      expect(result.badgePolicing).toBe(true);
    });

    it('denies badges when account is too recent', async () => {
      const newAccount = {
        ...oldAccount,
        created_at: new Date().toISOString(),
      };

      setupBadgeMocks(newAccount, 0, [
        { level: 1, topic_count: 5, up_weight: 10.0, total_weight: 10.0 },
        { level: 2, topic_count: 5, up_weight: 10.0, total_weight: 10.0 },
      ]);

      const result = await reputationService.checkBadges('acc-1');

      expect(result.badgeContribution).toBe(false);
      expect(result.badgePolicing).toBe(false);
    });

    it('denies badges when insufficient topics', async () => {
      setupBadgeMocks(oldAccount, 0, [
        { level: 1, topic_count: 2, up_weight: 10.0, total_weight: 10.0 },
        { level: 2, topic_count: 1, up_weight: 10.0, total_weight: 10.0 },
      ]);

      const result = await reputationService.checkBadges('acc-1');

      expect(result.badgeContribution).toBe(false);
      expect(result.badgePolicing).toBe(false);
    });

    it('denies contribution badge when account reputation is below 85%', async () => {
      const lowRepAccount = { ...oldAccount, reputation_contribution: 0.7 };
      setupBadgeMocks(lowRepAccount, 0, [
        { level: 1, topic_count: 5, up_weight: 10.0, total_weight: 10.0 },
        { level: 2, topic_count: 5, up_weight: 10.0, total_weight: 10.0 },
      ]);

      const result = await reputationService.checkBadges('acc-1');

      expect(result.badgeContribution).toBe(false);
      expect(result.badgePolicing).toBe(true);
    });

    it('denies policing badge when vote ratio is below 85%', async () => {
      setupBadgeMocks(oldAccount, 0, [
        { level: 1, topic_count: 5, up_weight: 10.0, total_weight: 10.0 },
        { level: 2, topic_count: 5, up_weight: 8.0, total_weight: 10.0 },
      ]);

      const result = await reputationService.checkBadges('acc-1');

      expect(result.badgeContribution).toBe(true);
      expect(result.badgePolicing).toBe(false);
    });

    it('denies badges when account has active flags', async () => {
      setupBadgeMocks(oldAccount, 2, [
        { level: 1, topic_count: 5, up_weight: 10.0, total_weight: 10.0 },
        { level: 2, topic_count: 5, up_weight: 10.0, total_weight: 10.0 },
      ]);

      const result = await reputationService.checkBadges('acc-1');

      expect(result.badgeContribution).toBe(false);
      expect(result.badgePolicing).toBe(false);
    });

    it('handles edge case: no votes returns no badges', async () => {
      setupBadgeMocks(oldAccount, 0, []);

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
            tier: 1,
            interaction_count: 10,
            created_at: '2026-01-01T00:00:00.000Z',
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
        tier: 1,
        tierName: 'Contributor',
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
      // recalculateAll processes accounts sequentially, each calling
      // recalculateReputation (sequential queries) then checkBadges (parallel queries).
      // Use a SQL-pattern-based mock to handle both patterns.
      let callIndex = 0;
      const responses = [
        // SELECT active accounts
        { rows: [{ id: 'acc-1' }, { id: 'acc-2' }] },
      ];

      mockPool.query.mockImplementation((sql) => {
        // First call: list active accounts (sequential, consumed first)
        if (callIndex === 0) {
          callIndex++;
          return Promise.resolve(responses[0]);
        }

        // recalculateReputation queries (level 1 / level 2 votes with down_weight)
        if (typeof sql === 'string' && sql.includes('down_weight') && sql.includes('level = 1')) {
          return Promise.resolve({ rows: [{ up_weight: 5, down_weight: 0 }] });
        }
        if (typeof sql === 'string' && sql.includes('down_weight') && sql.includes('level = 2')) {
          return Promise.resolve({ rows: [{ up_weight: 0, down_weight: 0 }] });
        }
        // recalculateReputation UPDATE
        if (typeof sql === 'string' && sql.includes('reputation_contribution = $1, reputation_policing')) {
          return Promise.resolve({ rowCount: 1 });
        }

        // checkBadges queries (parallel)
        if (typeof sql === 'string' && sql.includes('reputation_contribution') && sql.includes('badge_contribution')) {
          return Promise.resolve({ rows: [{ id: 'acc-1', created_at: '2025-01-01', reputation_contribution: 0.5, badge_contribution: false }] });
        }
        if (typeof sql === 'string' && sql.includes('flag_count')) {
          return Promise.resolve({ rows: [{ flag_count: 0 }] });
        }
        if (typeof sql === 'string' && sql.includes('m.level IN')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE accounts SET badge_')) {
          return Promise.resolve({ rowCount: 1 });
        }

        return Promise.resolve({ rows: [] });
      });

      const results = await reputationService.recalculateAll();

      expect(results).toHaveLength(2);
      expect(results[0].accountId).toBe('acc-1');
      expect(results[1].accountId).toBe('acc-2');
    });
  });

  describe('awardDeliberationBonus', () => {
    it('awards bonus to voters who discussed', async () => {
      mockPool.query
        // chunk_topics
        .mockResolvedValueOnce({ rows: [{ topic_id: 'topic-1' }] })
        // formal_votes (revealed voters)
        .mockResolvedValueOnce({ rows: [{ account_id: 'voter-1' }, { account_id: 'voter-2' }] })
        // activity_log (discussion participants)
        .mockResolvedValueOnce({ rows: [{ account_id: 'voter-1' }] })
        // UPDATE accounts (award bonus)
        .mockResolvedValueOnce({ rowCount: 1 })
        // INSERT activity_log (log)
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.awardDeliberationBonus('chunk-1');
      expect(result).toEqual(['voter-1']);
      // Verify UPDATE was called with DELTA_DELIB
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('LEAST(1.0'),
        expect.arrayContaining([0.02, 'voter-1'])
      );
    });

    it('returns empty if no voters discussed', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ topic_id: 'topic-1' }] })
        .mockResolvedValueOnce({ rows: [{ account_id: 'voter-1' }] })
        .mockResolvedValueOnce({ rows: [] }); // no discussion participants

      const result = await reputationService.awardDeliberationBonus('chunk-1');
      expect(result).toEqual([]);
    });

    it('returns empty if no revealed voters', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ topic_id: 'topic-1' }] })
        .mockResolvedValueOnce({ rows: [] }); // no voters

      const result = await reputationService.awardDeliberationBonus('chunk-1');
      expect(result).toEqual([]);
    });
  });

  describe('awardDissentBonus', () => {
    it('awards bonus to vindicated reject-voters', async () => {
      mockPool.query
        // formal_votes (minority voters who voted reject=-1)
        .mockResolvedValueOnce({ rows: [{ account_id: 'dissenter-1' }] })
        // UPDATE accounts
        .mockResolvedValueOnce({ rowCount: 1 })
        // INSERT activity_log
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await reputationService.awardDissentBonus('chunk-1', 'reject');
      expect(result).toEqual(['dissenter-1']);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('LEAST(1.0'),
        expect.arrayContaining([0.05, 'dissenter-1'])
      );
    });

    it('returns empty if no minority voters', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const result = await reputationService.awardDissentBonus('chunk-1', 'accept');
      expect(result).toEqual([]);
    });
  });
});
