import {
  T_FAST_LOW_MS,
  T_FAST_HIGH_MS,
  T_REVIEW_MS,
  T_DISPUTE_MS,
  TIMEOUT_CHECK_MS,
  DUPLICATE_THRESHOLD,
  NEW_ACCOUNT_DAYS,
  MAX_RESUBMIT_COUNT,
  TAU_ACCEPT,
  TAU_REJECT,
  Q_MIN,
  W_MIN,
  W_MAX,
  OBJECTION_REASON_TAGS,
  DELTA_DELIB,
  DELTA_DISSENT,
  MERGE_TIMEOUT_LOW_SENSITIVITY_MS,
  MERGE_TIMEOUT_HIGH_SENSITIVITY_MS,
  AUTO_MERGE_CHECK_INTERVAL_MS,
} from '../protocol';

describe('protocol constants', () => {
  test('timing defaults are sensible', () => {
    expect(T_FAST_LOW_MS).toBe(3 * 60 * 60 * 1000);   // 3h
    expect(T_FAST_HIGH_MS).toBe(6 * 60 * 60 * 1000);   // 6h
    expect(T_REVIEW_MS).toBe(24 * 60 * 60 * 1000);     // 24h
    expect(T_DISPUTE_MS).toBe(48 * 60 * 60 * 1000);    // 48h
    expect(TIMEOUT_CHECK_MS).toBe(5 * 60 * 1000);      // 5min
  });

  test('thresholds have expected values', () => {
    expect(DUPLICATE_THRESHOLD).toBe(0.95);
    expect(NEW_ACCOUNT_DAYS).toBe(14);
    expect(MAX_RESUBMIT_COUNT).toBe(3);
  });

  test('vote thresholds defined for Sprint 3', () => {
    expect(TAU_ACCEPT).toBe(0.6);
    expect(TAU_REJECT).toBe(-0.3);
    expect(Q_MIN).toBe(3);
    expect(W_MIN).toBe(0.1);
    expect(W_MAX).toBe(5.0);
  });

  test('objection reason tags are exhaustive', () => {
    expect(OBJECTION_REASON_TAGS).toEqual([
      'inaccurate', 'unsourced', 'redundant', 'harmful', 'unclear', 'copyright',
    ]);
  });

  test('reputation incentive defaults', () => {
    expect(DELTA_DELIB).toBe(0.02);
    expect(DELTA_DISSENT).toBe(0.05);
  });

  test('legacy aliases match new names', () => {
    expect(MERGE_TIMEOUT_LOW_SENSITIVITY_MS).toBe(T_FAST_LOW_MS);
    expect(MERGE_TIMEOUT_HIGH_SENSITIVITY_MS).toBe(T_FAST_HIGH_MS);
    expect(AUTO_MERGE_CHECK_INTERVAL_MS).toBe(TIMEOUT_CHECK_MS);
  });
});
