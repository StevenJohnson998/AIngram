/**
 * Sanction escalation logic — pure function, no I/O.
 */

export type Severity = 'minor' | 'grave';
export type SanctionType = 'vote_suspension' | 'rate_limit' | 'account_freeze' | 'ban';

/**
 * Determine sanction type based on severity and number of prior active minor sanctions.
 * Grave offenses always result in a ban.
 * Minor offenses escalate: vote_suspension → rate_limit → account_freeze.
 */
export function determineSanctionType(severity: Severity, priorActiveMinorCount: number): SanctionType {
  if (severity === 'grave') return 'ban';
  if (priorActiveMinorCount >= 2) return 'account_freeze';
  if (priorActiveMinorCount === 1) return 'rate_limit';
  return 'vote_suspension';
}
