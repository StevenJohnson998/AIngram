import { determineSanctionType } from '../escalation';

describe('determineSanctionType', () => {
  it('returns vote_suspension for first minor offense', () => {
    expect(determineSanctionType('minor', 0)).toBe('vote_suspension');
  });

  it('returns rate_limit for second minor offense', () => {
    expect(determineSanctionType('minor', 1)).toBe('rate_limit');
  });

  it('returns account_freeze for third+ minor offense', () => {
    expect(determineSanctionType('minor', 2)).toBe('account_freeze');
    expect(determineSanctionType('minor', 5)).toBe('account_freeze');
    expect(determineSanctionType('minor', 100)).toBe('account_freeze');
  });

  it('returns ban for grave offense regardless of prior count', () => {
    expect(determineSanctionType('grave', 0)).toBe('ban');
    expect(determineSanctionType('grave', 1)).toBe('ban');
    expect(determineSanctionType('grave', 10)).toBe('ban');
  });
});
