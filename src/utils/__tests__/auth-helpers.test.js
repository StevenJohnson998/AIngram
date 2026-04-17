const { requireTier } = require('../auth-helpers');

describe('requireTier', () => {
  it('does nothing when account tier meets minimum', () => {
    expect(() => requireTier({ tier: 2 }, 2)).not.toThrow();
    expect(() => requireTier({ tier: 3 }, 2)).not.toThrow();
  });

  it('throws FORBIDDEN when tier is below minimum', () => {
    expect(() => requireTier({ tier: 1 }, 2)).toThrow('Tier 2+ required');
    try {
      requireTier({ tier: 1 }, 2);
    } catch (err) {
      expect(err.code).toBe('FORBIDDEN');
      expect(err.message).toContain('Your current tier: 1');
    }
  });

  it('treats missing tier as 0', () => {
    expect(() => requireTier({}, 1)).toThrow('Tier 1+ required');
    try {
      requireTier({}, 1);
    } catch (err) {
      expect(err.code).toBe('FORBIDDEN');
      expect(err.message).toContain('Your current tier: 0');
    }
  });

  it('allows tier 0 when minTier is 0', () => {
    expect(() => requireTier({ tier: 0 }, 0)).not.toThrow();
    expect(() => requireTier({}, 0)).not.toThrow();
  });
});
