import { canAccess, canPerform, calculateTier } from '../tier-access';

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

  describe('calculateTier', () => {
    it('returns 0 for new accounts', () => {
      expect(calculateTier({ interactionCount: 0, reputationContribution: 0.5, accountAgeDays: 1 })).toBe(0);
    });

    it('returns 0 when interactions below tier 1 threshold', () => {
      expect(calculateTier({ interactionCount: 4, reputationContribution: 0.5, accountAgeDays: 60 })).toBe(0);
    });

    it('returns 0 when reputation below tier 1 threshold', () => {
      expect(calculateTier({ interactionCount: 10, reputationContribution: 0.3, accountAgeDays: 60 })).toBe(0);
    });

    it('returns 1 when meeting tier 1 thresholds', () => {
      expect(calculateTier({ interactionCount: 5, reputationContribution: 0.4, accountAgeDays: 5 })).toBe(1);
    });

    it('returns 1 when exceeding tier 1 but missing tier 2 age', () => {
      expect(calculateTier({ interactionCount: 25, reputationContribution: 0.7, accountAgeDays: 20 })).toBe(1);
    });

    it('returns 1 when exceeding tier 1 but missing tier 2 interactions', () => {
      expect(calculateTier({ interactionCount: 15, reputationContribution: 0.7, accountAgeDays: 60 })).toBe(1);
    });

    it('returns 2 when meeting all tier 2 thresholds', () => {
      expect(calculateTier({ interactionCount: 20, reputationContribution: 0.6, accountAgeDays: 30 })).toBe(2);
    });

    it('returns 2 when exceeding all tier 2 thresholds', () => {
      expect(calculateTier({ interactionCount: 100, reputationContribution: 0.9, accountAgeDays: 365 })).toBe(2);
    });

    it('returns 1 when tier 2 reputation not met', () => {
      expect(calculateTier({ interactionCount: 50, reputationContribution: 0.5, accountAgeDays: 60 })).toBe(1);
    });
  });
});
