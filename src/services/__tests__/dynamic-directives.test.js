jest.mock('../copyright-analytics');

const fs = require('fs');
const path = require('path');
const analyticsService = require('../copyright-analytics');
const { buildStatsSection } = require('../dynamic-directives');

describe('dynamic-directives service', () => {
  describe('buildStatsSection', () => {
    it('returns empty stats message when no reviews', () => {
      const result = buildStatsSection({ total_reviews: 0 });

      expect(result).toContain('No copyright reviews resolved yet');
      expect(result).toContain('auto-generated');
    });

    it('returns null/undefined analytics gracefully', () => {
      const result = buildStatsSection(null);

      expect(result).toContain('No copyright reviews resolved yet');
    });

    it('formats analytics data into markdown table', () => {
      const analytics = {
        total_reviews: 100,
        clear_count: 30,
        rewrite_count: 25,
        takedown_count: 45,
        avg_resolution_hours: 6.2,
        median_resolution_hours: 4.1,
        system_fp_rate: 0.3,
        high_priority_count: 5,
      };

      const result = buildStatsSection(analytics);

      expect(result).toContain('Total resolved reviews | 100');
      expect(result).toContain('Clear (unfounded) | 30 (30%)');
      expect(result).toContain('Takedown | 45 (45%)');
      expect(result).toContain('30.0%');
      expect(result).toContain('6.2 hours');
      expect(result).toContain('4.1 hours');
    });

    it('adds high FP rate warning when over 50%', () => {
      const analytics = {
        total_reviews: 20,
        clear_count: 12,
        rewrite_count: 3,
        takedown_count: 5,
        avg_resolution_hours: 3.0,
        median_resolution_hours: 2.5,
        system_fp_rate: 0.6,
        high_priority_count: 1,
      };

      const result = buildStatsSection(analytics);

      expect(result).toContain('Over half of reports are found unfounded');
    });

    it('adds low FP rate note when under 20% with enough data', () => {
      const analytics = {
        total_reviews: 50,
        clear_count: 5,
        rewrite_count: 15,
        takedown_count: 30,
        avg_resolution_hours: 8.0,
        median_resolution_hours: 6.0,
        system_fp_rate: 0.1,
        high_priority_count: 0,
      };

      const result = buildStatsSection(analytics);

      expect(result).toContain('Low false positive rate');
    });
  });
});
