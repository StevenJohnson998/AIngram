import {
  hashCommitment,
  verifyReveal,
  clampWeight,
  computeVoteScore,
  evaluateDecision,
  isValidFormalReasonTag,
  FORMAL_REASON_TAGS,
} from '../formal-vote';

describe('hashCommitment', () => {
  it('produces a 64-char hex SHA-256 hash', () => {
    const hash = hashCommitment(1, 'accurate', 'random-salt-123');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces consistent output for same inputs', () => {
    const a = hashCommitment(1, 'accurate', 'salt1');
    const b = hashCommitment(1, 'accurate', 'salt1');
    expect(a).toBe(b);
  });

  it('produces different hashes for different salts', () => {
    const a = hashCommitment(1, 'accurate', 'salt-a');
    const b = hashCommitment(1, 'accurate', 'salt-b');
    expect(a).not.toBe(b);
  });

  it('produces different hashes for different vote values', () => {
    const up = hashCommitment(1, 'accurate', 'same-salt');
    const down = hashCommitment(-1, 'accurate', 'same-salt');
    expect(up).not.toBe(down);
  });

  it('produces different hashes for different reason tags', () => {
    const a = hashCommitment(1, 'accurate', 'same-salt');
    const b = hashCommitment(1, 'harmful', 'same-salt');
    expect(a).not.toBe(b);
  });
});

describe('verifyReveal', () => {
  it('returns true for matching inputs', () => {
    const hash = hashCommitment(-1, 'inaccurate', 'my-salt');
    expect(verifyReveal(hash, -1, 'inaccurate', 'my-salt')).toBe(true);
  });

  it('returns false for tampered vote value', () => {
    const hash = hashCommitment(1, 'accurate', 'salt');
    expect(verifyReveal(hash, -1, 'accurate', 'salt')).toBe(false);
  });

  it('returns false for tampered reason tag', () => {
    const hash = hashCommitment(1, 'accurate', 'salt');
    expect(verifyReveal(hash, 1, 'harmful', 'salt')).toBe(false);
  });

  it('returns false for tampered salt', () => {
    const hash = hashCommitment(1, 'accurate', 'real-salt');
    expect(verifyReveal(hash, 1, 'accurate', 'fake-salt')).toBe(false);
  });
});

describe('clampWeight', () => {
  it('returns wMin when raw weight is below floor', () => {
    expect(clampWeight(0.05, 0.1, 5.0)).toBe(0.1);
  });

  it('returns wMax when raw weight exceeds ceiling', () => {
    expect(clampWeight(7.0, 0.1, 5.0)).toBe(5.0);
  });

  it('passes through values within range', () => {
    expect(clampWeight(1.5, 0.1, 5.0)).toBe(1.5);
  });

  it('returns wMin for exactly wMin', () => {
    expect(clampWeight(0.1, 0.1, 5.0)).toBe(0.1);
  });

  it('returns wMax for exactly wMax', () => {
    expect(clampWeight(5.0, 0.1, 5.0)).toBe(5.0);
  });
});

describe('computeVoteScore', () => {
  it('sums weighted votes correctly (all positive)', () => {
    const votes = [
      { weight: 1.0, voteValue: 1 as const },
      { weight: 1.5, voteValue: 1 as const },
      { weight: 0.5, voteValue: 1 as const },
    ];
    expect(computeVoteScore(votes)).toBeCloseTo(3.0);
  });

  it('sums weighted votes correctly (all negative)', () => {
    const votes = [
      { weight: 1.0, voteValue: -1 as const },
      { weight: 2.0, voteValue: -1 as const },
    ];
    expect(computeVoteScore(votes)).toBeCloseTo(-3.0);
  });

  it('sums mixed votes correctly', () => {
    const votes = [
      { weight: 1.0, voteValue: 1 as const },   // +1.0
      { weight: 1.5, voteValue: -1 as const },  // -1.5
      { weight: 0.8, voteValue: 1 as const },   // +0.8
    ];
    expect(computeVoteScore(votes)).toBeCloseTo(0.3);
  });

  it('handles abstain votes (value=0)', () => {
    const votes = [
      { weight: 1.0, voteValue: 1 as const },
      { weight: 2.0, voteValue: 0 as const },
      { weight: 1.0, voteValue: -1 as const },
    ];
    expect(computeVoteScore(votes)).toBeCloseTo(0.0);
  });

  it('returns 0 for empty vote list', () => {
    expect(computeVoteScore([])).toBe(0);
  });
});

describe('evaluateDecision', () => {
  const TAU_ACCEPT = 0.6;
  const TAU_REJECT = -0.3;
  const Q_MIN = 3;

  it('returns accept when score >= tauAccept and quorum met', () => {
    expect(evaluateDecision(0.8, 3, Q_MIN, TAU_ACCEPT, TAU_REJECT)).toBe('accept');
  });

  it('returns accept at exact threshold', () => {
    expect(evaluateDecision(0.6, 3, Q_MIN, TAU_ACCEPT, TAU_REJECT)).toBe('accept');
  });

  it('returns reject when score <= tauReject', () => {
    expect(evaluateDecision(-0.5, 3, Q_MIN, TAU_ACCEPT, TAU_REJECT)).toBe('reject');
  });

  it('returns reject at exact threshold', () => {
    expect(evaluateDecision(-0.3, 3, Q_MIN, TAU_ACCEPT, TAU_REJECT)).toBe('reject');
  });

  it('returns reject even below quorum (protective)', () => {
    expect(evaluateDecision(-0.5, 1, Q_MIN, TAU_ACCEPT, TAU_REJECT)).toBe('reject');
  });

  it('returns no_quorum when count < qMin and score is positive', () => {
    expect(evaluateDecision(0.8, 2, Q_MIN, TAU_ACCEPT, TAU_REJECT)).toBe('no_quorum');
  });

  it('returns indeterminate when between thresholds with quorum', () => {
    expect(evaluateDecision(0.2, 3, Q_MIN, TAU_ACCEPT, TAU_REJECT)).toBe('indeterminate');
  });

  it('returns indeterminate at zero score with quorum', () => {
    expect(evaluateDecision(0.0, 4, Q_MIN, TAU_ACCEPT, TAU_REJECT)).toBe('indeterminate');
  });
});

describe('isValidFormalReasonTag', () => {
  it('returns true for all valid tags', () => {
    for (const tag of FORMAL_REASON_TAGS) {
      expect(isValidFormalReasonTag(tag)).toBe(true);
    }
  });

  it('returns false for invalid tag', () => {
    expect(isValidFormalReasonTag('bogus')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isValidFormalReasonTag('')).toBe(false);
  });
});
