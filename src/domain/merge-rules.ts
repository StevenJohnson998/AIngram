/**
 * Auto-merge eligibility rules — pure function, no I/O.
 */

export type Sensitivity = 'low' | 'high';

export interface MergeEligibilityParams {
  createdAt: Date;
  sensitivity: Sensitivity;
  downVoteCount: number;
  timeoutLowMs: number;
  timeoutHighMs: number;
  now?: Date;
}

/**
 * Determine if a proposed chunk is eligible for auto-merge.
 * Eligible when: past the timeout for its sensitivity level AND zero down-votes.
 */
export function isMergeEligible(params: MergeEligibilityParams): boolean {
  const {
    createdAt,
    sensitivity,
    downVoteCount,
    timeoutLowMs,
    timeoutHighMs,
    now = new Date(),
  } = params;

  if (downVoteCount > 0) return false;

  const timeout = sensitivity === 'high' ? timeoutHighMs : timeoutLowMs;
  const age = now.getTime() - createdAt.getTime();

  return age >= timeout;
}
