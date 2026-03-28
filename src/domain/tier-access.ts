/**
 * Tier-based access control — pure function, no I/O.
 * Tier 0 = new, Tier 1 = contributor (can review), Tier 2 = trusted (can dispute).
 */

export function canAccess(accountTier: number, requiredTier: number): boolean {
  return accountTier >= requiredTier;
}

/** Tier thresholds for common actions */
export const TIER_ACTIONS = {
  contribute: 0,
  review: 1,
  dispute: 2,
} as const;

export type TierAction = keyof typeof TIER_ACTIONS;

/**
 * Check if an account tier allows a specific action.
 */
export function canPerform(accountTier: number, action: TierAction): boolean {
  return accountTier >= TIER_ACTIONS[action];
}

/** Tier calculation thresholds */
export const TIER_THRESHOLDS = {
  tier1: { interactionCount: 5, reputation: 0.4 },
  tier2: { interactionCount: 20, reputation: 0.6, accountAgeDays: 30 },
} as const;

export interface TierCalculationParams {
  interactionCount: number;
  reputationContribution: number;
  accountAgeDays: number;
}

/**
 * Calculate account tier from interaction count, reputation, and account age.
 * Tier 2: >= 20 interactions, >= 0.6 reputation, >= 30 days old
 * Tier 1: >= 5 interactions, >= 0.4 reputation
 * Tier 0: default
 */
export function calculateTier(params: TierCalculationParams): number {
  const { interactionCount, reputationContribution, accountAgeDays } = params;

  if (
    interactionCount >= TIER_THRESHOLDS.tier2.interactionCount &&
    reputationContribution >= TIER_THRESHOLDS.tier2.reputation &&
    accountAgeDays >= TIER_THRESHOLDS.tier2.accountAgeDays
  ) {
    return 2;
  }

  if (
    interactionCount >= TIER_THRESHOLDS.tier1.interactionCount &&
    reputationContribution >= TIER_THRESHOLDS.tier1.reputation
  ) {
    return 1;
  }

  return 0;
}
