jest.mock('../../config/database');

const { getPool } = require('../../config/database');
const { actionDistributionByArchetype, VALID_WINDOWS } = require('../archetype-analytics');

describe('archetype-analytics', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('actionDistributionByArchetype', () => {
    it('returns rows grouped by archetype and action (default week window)', async () => {
      const rows = [
        { archetype: 'curator', action: 'flag_reviewed', count: 42 },
        { archetype: null, action: 'changeset_timeout', count: 7 },
      ];
      mockPool.query.mockResolvedValue({ rows });

      const result = await actionDistributionByArchetype();

      expect(result).toEqual(rows);
      const sql = mockPool.query.mock.calls[0][0];
      expect(sql).toMatch(/metadata->>'archetype'/);
      expect(sql).toMatch(/GROUP BY metadata->>'archetype', action/);
      expect(sql).toMatch(/interval '7 days'/);
    });

    it("uses interval '1 hour' for window=hour", async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await actionDistributionByArchetype({ window: 'hour' });

      expect(mockPool.query.mock.calls[0][0]).toMatch(/interval '1 hour'/);
    });

    it('omits the time predicate when window=all', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await actionDistributionByArchetype({ window: 'all' });

      const sql = mockPool.query.mock.calls[0][0];
      expect(sql).toMatch(/WHERE TRUE/);
      expect(sql).not.toMatch(/interval/);
    });

    it('rejects invalid window', async () => {
      await expect(actionDistributionByArchetype({ window: 'bogus' }))
        .rejects.toThrow(/window must be one of/);
    });

    it('exposes VALID_WINDOWS', () => {
      expect(VALID_WINDOWS).toContain('week');
      expect(VALID_WINDOWS).toContain('all');
    });
  });
});
