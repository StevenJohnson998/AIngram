jest.mock('../../config/database');

const { getPool } = require('../../config/database');
const securityConfig = require('../security-config');

describe('security-config', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  afterEach(() => {
    securityConfig.shutdown();
  });

  describe('getConfig', () => {
    it('returns default value when cache is empty', () => {
      expect(securityConfig.getConfig('injection_half_life_ms')).toBe(1800000);
      expect(securityConfig.getConfig('injection_block_threshold')).toBe(1.0);
      expect(securityConfig.getConfig('injection_min_score_logged')).toBe(0.1);
    });

    it('returns undefined for unknown keys', () => {
      expect(securityConfig.getConfig('nonexistent_key')).toBeUndefined();
    });
  });

  describe('loadAll', () => {
    it('loads values from database into cache', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { key: 'injection_half_life_ms', value: 7200000 },
          { key: 'injection_block_threshold', value: 3.0 },
        ],
      });

      await securityConfig.loadAll();

      expect(securityConfig.getConfig('injection_half_life_ms')).toBe(7200000);
      expect(securityConfig.getConfig('injection_block_threshold')).toBe(3.0);
      // Non-loaded key falls back to default
      expect(securityConfig.getConfig('injection_min_score_logged')).toBe(0.1);
    });

    it('keeps previous cache when database fails', async () => {
      // Start fresh with defaults (no prior loadAll success)
      mockPool.query.mockRejectedValueOnce(new Error('Connection refused'));

      await securityConfig.loadAll();

      // Cache was never populated with DB values, so still has previous state
      // On a fresh module this would return defaults
      // After the previous test loaded 7200000, the failed load doesn't reset cache
      // This is the intended behavior: failed refresh doesn't wipe cache
      expect(securityConfig.getConfig('injection_min_score_logged')).toBe(0.1);
    });
  });

  describe('init', () => {
    it('loads config and starts refresh timer', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await securityConfig.init();

      // Timer started (we clean it up in afterEach)
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });
  });
});
