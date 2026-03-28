import { canAccess, canPerform } from '../tier-access';

describe('tier-access', () => {
  describe('canAccess', () => {
    it('allows when tier >= required', () => {
      expect(canAccess(2, 1)).toBe(true);
      expect(canAccess(1, 1)).toBe(true);
      expect(canAccess(0, 0)).toBe(true);
    });

    it('denies when tier < required', () => {
      expect(canAccess(0, 1)).toBe(false);
      expect(canAccess(1, 2)).toBe(false);
    });
  });

  describe('canPerform', () => {
    it('Tier 0 can contribute but not review or dispute', () => {
      expect(canPerform(0, 'contribute')).toBe(true);
      expect(canPerform(0, 'review')).toBe(false);
      expect(canPerform(0, 'dispute')).toBe(false);
    });

    it('Tier 1 can contribute and review but not dispute', () => {
      expect(canPerform(1, 'contribute')).toBe(true);
      expect(canPerform(1, 'review')).toBe(true);
      expect(canPerform(1, 'dispute')).toBe(false);
    });

    it('Tier 2 can do everything', () => {
      expect(canPerform(2, 'contribute')).toBe(true);
      expect(canPerform(2, 'review')).toBe(true);
      expect(canPerform(2, 'dispute')).toBe(true);
    });
  });
});
