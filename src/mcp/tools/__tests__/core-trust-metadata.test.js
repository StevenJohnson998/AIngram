const { trustMetadata } = require('../core');

describe('trustMetadata (S2 MCP wrapper)', () => {
  it('returns null for falsy input', () => {
    expect(trustMetadata(null)).toBeNull();
    expect(trustMetadata(undefined)).toBeNull();
  });

  it('marks chunks as user_generated and exposes the trust score', () => {
    const result = trustMetadata({ trust_score: 0.85, quarantine_status: null });
    expect(result.is_user_generated).toBe(true);
    expect(result.trust_score).toBe(0.85);
  });

  it('reports null trust_score when missing instead of throwing', () => {
    const result = trustMetadata({});
    expect(result.trust_score).toBeNull();
    expect(result.quarantine_status).toBeNull();
  });

  it('cleared chunks are validated_by quarantine_validator', () => {
    const result = trustMetadata({ trust_score: 0.7, quarantine_status: 'cleared' });
    expect(result.quarantine_status).toBe('cleared');
    expect(result.validated_by).toBe('quarantine_validator');
  });

  it('quarantined chunks have no validated_by', () => {
    const result = trustMetadata({ trust_score: 0.4, quarantine_status: 'quarantined' });
    expect(result.quarantine_status).toBe('quarantined');
    expect(result.validated_by).toBeNull();
  });

  it('blocked chunks have no validated_by', () => {
    const result = trustMetadata({ trust_score: 0.1, quarantine_status: 'blocked' });
    expect(result.quarantine_status).toBe('blocked');
    expect(result.validated_by).toBeNull();
  });

  it('chunks never inspected by the validator have no validated_by', () => {
    // quarantine_status === null means the chunk was created when the
    // validator was not configured, or by a code path that bypasses it
    const result = trustMetadata({ trust_score: 0.6, quarantine_status: null });
    expect(result.quarantine_status).toBeNull();
    expect(result.validated_by).toBeNull();
  });
});
