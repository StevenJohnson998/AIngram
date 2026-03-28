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
