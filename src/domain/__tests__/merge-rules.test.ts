import { isMergeEligible } from '../merge-rules';

describe('isMergeEligible', () => {
  const baseParams = {
    timeoutLowMs: 3 * 60 * 60 * 1000,  // 3h
    timeoutHighMs: 6 * 60 * 60 * 1000, // 6h
    downVoteCount: 0,
    sensitivity: 'low' as const,
  };

  it('returns true when past low-sensitivity timeout with zero down-votes', () => {
    const result = isMergeEligible({
      ...baseParams,
      createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000), // 4h ago
      now: new Date(),
    });
    expect(result).toBe(true);
  });

  it('returns false when within low-sensitivity timeout', () => {
    const result = isMergeEligible({
      ...baseParams,
      createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000), // 1h ago
      now: new Date(),
    });
    expect(result).toBe(false);
  });

  it('returns false when past low timeout but has down-votes', () => {
    const result = isMergeEligible({
      ...baseParams,
      downVoteCount: 2,
      createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
      now: new Date(),
    });
    expect(result).toBe(false);
  });

  it('uses high-sensitivity timeout for high topics', () => {
    const result = isMergeEligible({
      ...baseParams,
      sensitivity: 'high',
      createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000), // 4h — past low but not high
      now: new Date(),
    });
    expect(result).toBe(false);

    const result2 = isMergeEligible({
      ...baseParams,
      sensitivity: 'high',
      createdAt: new Date(Date.now() - 7 * 60 * 60 * 1000), // 7h — past high too
      now: new Date(),
    });
    expect(result2).toBe(true);
  });
});
