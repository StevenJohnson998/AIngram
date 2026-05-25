jest.mock('../../config/database');
jest.mock('../../config/trust', () => ({
  REP_PRIOR_ALPHA: 1,
  REP_PRIOR_BETA: 1,
  MOMENTUM_PER_CHUNK: 0.15,
  MOMENTUM_PER_SOURCE: 0.10,
  MOMENTUM_CAP: 5.0,
  MOMENTUM_DAILY_CAP: 5,
  MOMENTUM_WEEKLY_CAP: 10,
  PENALTY_FLAG: 1.0,
  PENALTY_SUSPENSION: 3.0,
  PENALTY_BAN: 20.0,
  PENALTY_FLAG_DECAY_DAYS: 180,
  PENALTY_SUSPENSION_DECAY_DAYS: 365,
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

  describe('recalculateReputation (Beta + Momentum)', () => {
    // Beta: rep = (prior_α + up + momentum) / (prior_α + up + momentum + prior_β + down)
    // With priors [1, 1] and 0 momentum: rep = (1 + up) / (2 + up + down)
    // Momentum = min(5.0, eff_chunks * 0.15 + eff_sourced * 0.10)

    function setupRepMocks({ contribUp = 0, contribDown = 0, policingUp = 0, policingDown = 0, effChunks = 0, effSourced = 0, totalPenalty = 0 } = {}) {
      mockPool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('level = 1')) {
          return Promise.resolve({ rows: [{ up_weight: contribUp, down_weight: contribDown }] });
        }
        if (typeof sql === 'string' && sql.includes('effective_chunks')) {
          return Promise.resolve({ rows: [{ effective_chunks: effChunks, effective_sourced: effSourced }] });
        }
        if (typeof sql === 'string' && sql.includes('level = 2')) {
          return Promise.resolve({ rows: [{ up_weight: policingUp, down_weight: policingDown }] });
        }
        if (typeof sql === 'string' && sql.includes('total_penalty')) {
          return Promise.resolve({ rows: [{ total_penalty: totalPenalty }] });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE accounts SET reputation_contribution')) {
          return Promise.resolve({ rowCount: 1 });
        }
        return Promise.resolve({ rows: [] });
      });
    }

    it('calculates high reputation when all votes are up (0 momentum)', async () => {
      setupRepMocks({ contribUp: 5.0, policingUp: 3.0 });
      const result = await reputationService.recalculateReputation('acc-1');
      // (1+5+0)/(1+5+0+1+0) = 6/7 ≈ 0.857
      expect(result.reputationContribution).toBeCloseTo(6 / 7, 5);
      // (1+3)/(1+3+1+0) = 4/5 = 0.8
      expect(result.reputationPolicing).toBeCloseTo(4 / 5, 5);
    });

    it('calculates low reputation when all votes are down', async () => {
      setupRepMocks({ contribDown: 4.0, policingDown: 2.0 });
      const result = await reputationService.recalculateReputation('acc-1');
      // (1+0+0)/(1+0+0+1+4) = 1/6 ≈ 0.167
      expect(result.reputationContribution).toBeCloseTo(1 / 6, 5);
      expect(result.reputationPolicing).toBeCloseTo(1 / 4, 5);
    });

    it('calculates mixed reputation correctly', async () => {
      setupRepMocks({ contribUp: 3.0, contribDown: 1.0, policingUp: 2.0, policingDown: 2.0 });
      const result = await reputationService.recalculateReputation('acc-1');
      // (1+3+0)/(1+3+0+1+1) = 4/6 ≈ 0.667
      expect(result.reputationContribution).toBeCloseTo(4 / 6, 5);
      expect(result.reputationPolicing).toBeCloseTo(3 / 6, 5);
    });

    it('returns 0.5 (neutral prior) when no votes and no momentum', async () => {
      setupRepMocks();
      const result = await reputationService.recalculateReputation('acc-1');
      expect(result.reputationContribution).toBe(0.5);
      expect(result.reputationPolicing).toBe(0.5);
    });

    it('momentum increases contribution reputation', async () => {
      setupRepMocks({ effChunks: 20 });
      const result = await reputationService.recalculateReputation('acc-1');
      // momentum = 20 * 0.15 = 3.0
      // α = 1 + 0 + 3.0 = 4.0, β = 1 → rep = 4/5 = 0.80
      expect(result.reputationContribution).toBeCloseTo(0.8, 5);
      expect(result.reputationPolicing).toBe(0.5);
    });

    it('sourced chunks add extra momentum', async () => {
      setupRepMocks({ effChunks: 10, effSourced: 8 });
      const result = await reputationService.recalculateReputation('acc-1');
      // momentum = 10*0.15 + 8*0.10 = 1.5 + 0.8 = 2.3
      // α = 1 + 2.3 = 3.3, β = 1 → rep = 3.3/4.3 ≈ 0.767
      expect(result.reputationContribution).toBeCloseTo(3.3 / 4.3, 4);
    });

    it('momentum caps at 5.0', async () => {
      setupRepMocks({ effChunks: 50 });
      const result = await reputationService.recalculateReputation('acc-1');
      // momentum = min(5.0, 50*0.15) = min(5.0, 7.5) = 5.0
      // α = 1 + 5.0 = 6.0, β = 1 → rep = 6/7 ≈ 0.857
      expect(result.reputationContribution).toBeCloseTo(6 / 7, 5);
    });

    it('momentum does not affect policing reputation', async () => {
      setupRepMocks({ effChunks: 30 });
      const result = await reputationService.recalculateReputation('acc-1');
      expect(result.reputationPolicing).toBe(0.5);
    });

    it('downvotes counteract momentum', async () => {
      setupRepMocks({ effChunks: 30, contribDown: 2.0 });
      const result = await reputationService.recalculateReputation('acc-1');
      // momentum = 30*0.15 = 4.5
      // α = 1 + 0 + 4.5 = 5.5, β = 1 + 2 = 3 → rep = 5.5/8.5 ≈ 0.647
      expect(result.reputationContribution).toBeCloseTo(5.5 / 8.5, 4);
    });

    it('updates the accounts table with computed values', async () => {
      setupRepMocks({ contribUp: 8.0, contribDown: 2.0, policingUp: 1.0, policingDown: 1.0, effChunks: 10 });
      await reputationService.recalculateReputation('acc-1');

      const updateCall = mockPool.query.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('UPDATE accounts')
      );
      expect(updateCall).toBeDefined();
      // momentum = 10*0.15 = 1.5
      // contribution: (1+8+1.5)/(1+8+1.5+1+2) = 10.5/13.5 ≈ 0.778
      expect(updateCall[1][0]).toBeCloseTo(10.5 / 13.5, 4);
      // policing: (1+1)/(1+1+1+1) = 2/4 = 0.5
      expect(updateCall[1][1]).toBeCloseTo(0.5, 5);
      expect(updateCall[1][2]).toBe('acc-1');
    });

    it('validated flag reduces reputation via β penalty', async () => {
      // 1 fresh flag = penalty 1.0
      setupRepMocks({ effChunks: 30, totalPenalty: 1.0 });
      const result = await reputationService.recalculateReputation('acc-1');
      // momentum = 4.5, α = 5.5, β = 1 + 0 + 1.0 = 2.0 → rep = 5.5/7.5 ≈ 0.733
      expect(result.reputationContribution).toBeCloseTo(5.5 / 7.5, 4);
    });

    it('vote suspension severely reduces reputation', async () => {
      // 1 fresh suspension = penalty 3.0
      setupRepMocks({ effChunks: 30, totalPenalty: 3.0 });
      const result = await reputationService.recalculateReputation('acc-1');
      // α = 5.5, β = 1 + 3.0 = 4.0 → rep = 5.5/9.5 ≈ 0.579
      expect(result.reputationContribution).toBeCloseTo(5.5 / 9.5, 4);
    });

    it('ban destroys reputation', async () => {
      setupRepMocks({ effChunks: 30, totalPenalty: 20.0 });
      const result = await reputationService.recalculateReputation('acc-1');
      // α = 5.5, β = 1 + 20.0 = 21.0 → rep = 5.5/26.5 ≈ 0.208
      expect(result.reputationContribution).toBeCloseTo(5.5 / 26.5, 4);
    });

    it('decayed flag has partial penalty', async () => {
      // Flag at 90 days: penalty = 1.0 * max(0, 1 - 90/180) = 0.5
      setupRepMocks({ effChunks: 30, totalPenalty: 0.5 });
      const result = await reputationService.recalculateReputation('acc-1');
      // α = 5.5, β = 1 + 0.5 = 1.5 → rep = 5.5/7.0 ≈ 0.786
      expect(result.reputationContribution).toBeCloseTo(5.5 / 7.0, 4);
    });

    it('cumulative penalties stack', async () => {
      // 2 flags + 1 suspension = 2*1.0 + 3.0 = 5.0
      setupRepMocks({ effChunks: 30, totalPenalty: 5.0 });
      const result = await reputationService.recalculateReputation('acc-1');
      // α = 5.5, β = 1 + 5.0 = 6.0 → rep = 5.5/11.5 ≈ 0.478
      expect(result.reputationContribution).toBeCloseTo(5.5 / 11.5, 4);
    });

    it('penalty does not affect policing reputation', async () => {
      setupRepMocks({ totalPenalty: 10.0 });
      const result = await reputationService.recalculateReputation('acc-1');
      expect(result.reputationPolicing).toBe(0.5);
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
      let callIndex = 0;

      mockPool.query.mockImplementation((sql) => {
        if (callIndex === 0) {
          callIndex++;
          return Promise.resolve({ rows: [{ id: 'acc-1' }, { id: 'acc-2' }] });
        }

        // recalculateReputation: contribution votes
        if (typeof sql === 'string' && sql.includes('down_weight') && sql.includes('level = 1')) {
          return Promise.resolve({ rows: [{ up_weight: 5, down_weight: 0 }] });
        }
        // recalculateReputation: momentum
        if (typeof sql === 'string' && sql.includes('effective_chunks')) {
          return Promise.resolve({ rows: [{ effective_chunks: 0, effective_sourced: 0 }] });
        }
        // recalculateReputation: policing votes
        if (typeof sql === 'string' && sql.includes('down_weight') && sql.includes('level = 2')) {
          return Promise.resolve({ rows: [{ up_weight: 0, down_weight: 0 }] });
        }
        // recalculateReputation: sanction penalty
        if (typeof sql === 'string' && sql.includes('total_penalty')) {
          return Promise.resolve({ rows: [{ total_penalty: 0 }] });
        }
        if (typeof sql === 'string' && sql.includes('reputation_contribution = $1, reputation_policing')) {
          return Promise.resolve({ rowCount: 1 });
        }

        // checkBadges queries
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

  describe('propagateChunkTrustBatched', () => {
    it('recalculates trust for all non-retracted chunks', async () => {
      mockPool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('status NOT IN')) {
          return Promise.resolve({ rows: [{ id: 'c-1' }, { id: 'c-2' }] });
        }
        if (typeof sql === 'string' && sql.includes('badge_elite')) {
          return Promise.resolve({ rows: [{ created_by: 'a-1', created_at: new Date().toISOString(), badge_elite: false, badge_contribution: true }] });
        }
        if (typeof sql === 'string' && sql.includes('source_count')) {
          return Promise.resolve({ rows: [{ source_count: 0 }] });
        }
        if (typeof sql === 'string' && sql.includes('voter_rep')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE chunks')) {
          return Promise.resolve({ rowCount: 1 });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await reputationService.propagateChunkTrustBatched({ batchSize: 10, pauseMs: 0 });
      expect(result.updated).toBe(2);

      const updateCalls = mockPool.query.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('UPDATE chunks'));
      expect(updateCalls).toHaveLength(2);
    });

    it('returns zero when no chunks exist', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const result = await reputationService.propagateChunkTrustBatched();
      expect(result.updated).toBe(0);
    });

    it('continues on individual chunk failure', async () => {
      let callCount = 0;
      mockPool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('status NOT IN')) {
          return Promise.resolve({ rows: [{ id: 'c-ok' }, { id: 'c-fail' }] });
        }
        if (typeof sql === 'string' && sql.includes('badge_elite')) {
          callCount++;
          if (callCount === 2) return Promise.reject(new Error('DB error'));
          return Promise.resolve({ rows: [{ created_by: 'a-1', created_at: new Date().toISOString(), badge_elite: false, badge_contribution: false }] });
        }
        if (typeof sql === 'string' && sql.includes('source_count')) {
          return Promise.resolve({ rows: [{ source_count: 0 }] });
        }
        if (typeof sql === 'string' && sql.includes('voter_rep')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE chunks')) {
          return Promise.resolve({ rowCount: 1 });
        }
        return Promise.resolve({ rows: [] });
      });

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      const result = await reputationService.propagateChunkTrustBatched({ batchSize: 10, pauseMs: 0 });
      expect(result.updated).toBe(1);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('c-fail'), expect.any(String));
      consoleSpy.mockRestore();
    });
  });
});
