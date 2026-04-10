const { TokenBucket, CircuitBreaker, shouldQuarantine } = require('../guardian');

describe('Guardian', () => {
  describe('TokenBucket', () => {
    it('allows burst up to burstSize', () => {
      const bucket = new TokenBucket(5, 3);
      expect(bucket.tryConsume()).toBe(true);
      expect(bucket.tryConsume()).toBe(true);
      expect(bucket.tryConsume()).toBe(true);
      expect(bucket.tryConsume()).toBe(false); // exhausted
    });

    it('refills over time', () => {
      const bucket = new TokenBucket(60, 1); // 1 per second
      bucket.tryConsume(); // drain
      expect(bucket.tryConsume()).toBe(false);

      // Simulate 2 seconds passing
      bucket.lastRefill = Date.now() - 2000;
      expect(bucket.tryConsume()).toBe(true);
    });

    it('does not exceed burstSize on refill', () => {
      const bucket = new TokenBucket(60, 3);
      // Simulate 10 seconds passing (would add 10 tokens, but capped at 3)
      bucket.lastRefill = Date.now() - 10000;
      bucket.tokens = 0;
      bucket._refill();
      expect(bucket.tokens).toBe(3);
    });
  });

  describe('CircuitBreaker', () => {
    it('starts closed', () => {
      const cb = new CircuitBreaker(3, 60000);
      expect(cb.isOpen()).toBe(false);
    });

    it('opens when threshold reached within window', () => {
      const cb = new CircuitBreaker(3, 60000);
      cb.recordArrival();
      cb.recordArrival();
      expect(cb.isOpen()).toBe(false);
      cb.recordArrival();
      expect(cb.isOpen()).toBe(true);
    });

    it('does not open for arrivals outside window', () => {
      const cb = new CircuitBreaker(3, 1000); // 1 second window
      cb.arrivals = [Date.now() - 2000, Date.now() - 1500]; // old
      cb.recordArrival(); // only 1 in window
      expect(cb.isOpen()).toBe(false);
    });

    it('resets correctly', () => {
      const cb = new CircuitBreaker(2, 60000);
      cb.recordArrival();
      cb.recordArrival();
      expect(cb.isOpen()).toBe(true);
      cb.reset();
      expect(cb.isOpen()).toBe(false);
      expect(cb.arrivals).toEqual([]);
    });
  });

  describe('shouldQuarantine', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv, GUARDIAN_API_KEY: 'test-key' };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('returns quarantined=false when no API key', () => {
      delete process.env.GUARDIAN_API_KEY;
      const result = shouldQuarantine({ score: 0.9, flags: ['instruction_override'] });
      expect(result.quarantined).toBe(false);
    });

    it('returns quarantined=false when score below threshold', () => {
      const result = shouldQuarantine({ score: 0.1, flags: [] });
      expect(result.quarantined).toBe(false);
    });

    it('returns quarantined=true when score above threshold', () => {
      const result = shouldQuarantine({ score: 0.5, flags: ['instruction_override'] });
      expect(result.quarantined).toBe(true);
    });

    it('returns quarantined=false for null injection result', () => {
      const result = shouldQuarantine(null);
      expect(result.quarantined).toBe(false);
    });

    it('respects custom threshold via env var', () => {
      process.env.GUARDIAN_INJECTION_THRESHOLD = '0.8';
      const result = shouldQuarantine({ score: 0.6, flags: ['instruction_override'] });
      expect(result.quarantined).toBe(false);

      const result2 = shouldQuarantine({ score: 0.9, flags: ['instruction_override'] });
      expect(result2.quarantined).toBe(true);
    });
  });
});
