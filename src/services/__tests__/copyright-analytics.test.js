jest.mock('../../config/database');

const { getPool } = require('../../config/database');
const analyticsService = require('../copyright-analytics');

describe('copyright-analytics service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('getOverview', () => {
    it('returns analytics when data exists', async () => {
      const analytics = {
        total_reviews: 42,
        clear_count: 10,
        rewrite_count: 12,
        takedown_count: 20,
        avg_resolution_hours: 4.5,
        median_resolution_hours: 3.2,
        system_fp_rate: 0.238,
        high_priority_count: 3,
        refreshed_at: new Date(),
      };
      mockPool.query.mockResolvedValueOnce({ rows: [analytics] });

      const result = await analyticsService.getOverview();

      expect(result.total_reviews).toBe(42);
      expect(result.system_fp_rate).toBe(0.238);
    });

    it('returns defaults when no data', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await analyticsService.getOverview();

      expect(result.total_reviews).toBe(0);
      expect(result.refreshed_at).toBeNull();
    });
  });

  describe('getReporterStats', () => {
    it('returns paginated reporter stats', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 1 }] })
        .mockResolvedValueOnce({
          rows: [{ reporter_id: 'r-1', total_reports: 5, fp_rate: 0.2, reporter_name: 'Alice' }],
        });

      const result = await analyticsService.getReporterStats({ page: 1, limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
    });

    it('rejects invalid sortBy with fallback to total_reports', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 0 }] })
        .mockResolvedValueOnce({ rows: [] });

      await analyticsService.getReporterStats({ sortBy: 'DROP TABLE;--' });

      const dataQuery = mockPool.query.mock.calls[1][0];
      expect(dataQuery).toContain('total_reports DESC');
      expect(dataQuery).not.toContain('DROP');
    });
  });

  describe('getVerdictTimeline', () => {
    it('returns daily verdict counts', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { day: '2026-03-28', total: 5, clear_count: 2, rewrite_count: 1, takedown_count: 2 },
          { day: '2026-03-29', total: 3, clear_count: 1, rewrite_count: 0, takedown_count: 2 },
        ],
      });

      const result = await analyticsService.getVerdictTimeline({ days: 7 });

      expect(result).toHaveLength(2);
      expect(result[0].day).toBe('2026-03-28');
    });
  });

  describe('refreshViews', () => {
    it('refreshes both materialized views', async () => {
      mockPool.query.mockResolvedValue({});

      await analyticsService.refreshViews();

      expect(mockPool.query).toHaveBeenCalledTimes(2);
      expect(mockPool.query.mock.calls[0][0]).toContain('copyright_analytics');
      expect(mockPool.query.mock.calls[1][0]).toContain('copyright_reporter_stats');
    });

    it('logs error on failure without throwing', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('relation does not exist'));
      const spy = jest.spyOn(console, 'error').mockImplementation();

      await analyticsService.refreshViews();

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
