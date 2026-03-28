import { calculateVoteWeight } from '../vote-weight';

describe('calculateVoteWeight', () => {
  const baseParams = {
    newAccountThresholdDays: 14,
    weightNew: 0.5,
    weightEstablished: 1.0,
    voterReputation: 0.5,
    voterRepBase: 0.5,
  };

  it('returns lower weight for new accounts', () => {
    const weight = calculateVoteWeight({
      ...baseParams,
      accountCreatedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // 1 day old
      now: new Date(),
    });
    // baseWeight=0.5 * (0.5+0.5)=1.0 → 0.5
    expect(weight).toBe(0.5);
  });

  it('returns higher weight for established accounts', () => {
    const weight = calculateVoteWeight({
      ...baseParams,
      accountCreatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days old
      now: new Date(),
    });
    // baseWeight=1.0 * (0.5+0.5)=1.0 → 1.0
    expect(weight).toBe(1.0);
  });

  it('factors in high voter reputation', () => {
    const weight = calculateVoteWeight({
      ...baseParams,
      accountCreatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      voterReputation: 0.9,
      now: new Date(),
    });
    // baseWeight=1.0 * (0.5+0.9)=1.4 → 1.4
    expect(weight).toBeCloseTo(1.4);
  });

  it('factors in low voter reputation', () => {
    const weight = calculateVoteWeight({
      ...baseParams,
      accountCreatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      voterReputation: 0.1,
      now: new Date(),
    });
    // baseWeight=1.0 * (0.5+0.1)=0.6 → 0.6
    expect(weight).toBeCloseTo(0.6);
  });

  it('uses exact threshold boundary correctly', () => {
    const now = new Date();
    const exactly14DaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const weight = calculateVoteWeight({
      ...baseParams,
      accountCreatedAt: exactly14DaysAgo,
      now,
    });
    // Exactly at threshold → accountAgeMs == thresholdMs → NOT less than → established
    expect(weight).toBe(1.0);
  });
});
