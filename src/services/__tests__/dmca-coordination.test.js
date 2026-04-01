jest.mock('../../config/database');

const { getPool } = require('../../config/database');
const { detectCoordination, jaccardSimilarity } = require('../dmca-coordination');

describe('dmca-coordination', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('jaccardSimilarity', () => {
    it('returns 1 for identical texts', () => {
      expect(jaccardSimilarity('copyright infringement detected', 'copyright infringement detected')).toBe(1);
    });

    it('returns 0 for completely different texts', () => {
      expect(jaccardSimilarity('copyright infringement', 'quantum computing algorithm')).toBe(0);
    });

    it('returns value between 0 and 1 for partial overlap', () => {
      const sim = jaccardSimilarity('copyright infringement detected content', 'copyright violation found content');
      expect(sim).toBeGreaterThan(0);
      expect(sim).toBeLessThan(1);
    });

    it('ignores stop words and short words', () => {
      const sim = jaccardSimilarity('the copyright is infringed', 'a copyright was infringed');
      expect(sim).toBe(1); // Only 'copyright' and 'infringed' remain after filtering
    });
  });

  describe('detectCoordination', () => {
    it('detects author targeting when 3+ reporters target same author', async () => {
      // Query 1: author targeting count
      mockPool.query.mockResolvedValueOnce({ rows: [{ reporter_count: 2 }] });
      // Query 2: sybil detection - reporter accounts
      mockPool.query.mockResolvedValueOnce({ rows: [
        { id: 'r1', created_at: '2026-01-01T00:00:00Z' },
        { id: 'r2', created_at: '2026-06-01T00:00:00Z' },
        { id: 'r3', created_at: '2026-03-15T00:00:00Z' },
      ]});
      // Query 3: report-only account check
      mockPool.query.mockResolvedValueOnce({ rows: [{ chunk_count: 5, message_count: 2 }] });
      // Query 4: copy-paste claims
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await detectCoordination({
        chunkId: 'chunk-1',
        reporterId: 'reporter-3',
        reason: 'This content infringes my copyright',
      });

      expect(result.isCoordinated).toBe(true);
      expect(result.signals).toContain('author_targeting');
      expect(result.details.author_targeting.reporter_count).toBe(3);
    });

    it('detects sybil accounts created within window', async () => {
      // Query 1: author targeting - below threshold
      mockPool.query.mockResolvedValueOnce({ rows: [{ reporter_count: 1 }] });
      // Query 2: sybil detection - accounts created within 24h of each other
      mockPool.query.mockResolvedValueOnce({ rows: [
        { id: 'r1', created_at: '2026-03-29T10:00:00Z' },
        { id: 'r2', created_at: '2026-03-29T15:00:00Z' },
      ]});
      // Query 3: report-only check
      mockPool.query.mockResolvedValueOnce({ rows: [{ chunk_count: 5, message_count: 2 }] });
      // Query 4: copy-paste
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await detectCoordination({
        chunkId: 'chunk-1',
        reporterId: 'reporter-2',
        reason: 'Unique claim text here',
      });

      expect(result.signals).toContain('sybil_accounts');
      expect(result.details.sybil_accounts.pairs_detected).toBe(1);
    });

    it('detects report-only accounts', async () => {
      // Query 1: author targeting - below threshold
      mockPool.query.mockResolvedValueOnce({ rows: [{ reporter_count: 0 }] });
      // Query 2: sybil - single account
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'r1', created_at: '2026-01-01T00:00:00Z' }] });
      // Query 3: report-only - zero chunks and messages
      mockPool.query.mockResolvedValueOnce({ rows: [{ chunk_count: 0, message_count: 0 }] });
      // Query 4: copy-paste
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await detectCoordination({
        chunkId: 'chunk-1',
        reporterId: 'reporter-1',
        reason: 'Some claim',
      });

      expect(result.signals).toContain('report_only_account');
    });

    it('detects copy-paste claims', async () => {
      // Query 1: author targeting - below threshold
      mockPool.query.mockResolvedValueOnce({ rows: [{ reporter_count: 0 }] });
      // Query 2: sybil
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'r1', created_at: '2026-01-01T00:00:00Z' }] });
      // Query 3: report-only
      mockPool.query.mockResolvedValueOnce({ rows: [{ chunk_count: 5, message_count: 2 }] });
      // Query 4: copy-paste - similar claims from other reporters
      mockPool.query.mockResolvedValueOnce({ rows: [
        { reason: 'This content infringes copyright material from our publication', flagged_by: 'other-reporter' },
      ]});

      const result = await detectCoordination({
        chunkId: 'chunk-1',
        reporterId: 'reporter-1',
        reason: 'This content infringes copyright material from our official publication',
      });

      expect(result.signals).toContain('copy_paste_claims');
      expect(result.details.copy_paste_claims.similar_count).toBe(1);
    });

    it('returns no signals for legitimate single reporter', async () => {
      // Query 1: author targeting - zero other reporters
      mockPool.query.mockResolvedValueOnce({ rows: [{ reporter_count: 0 }] });
      // Query 2: sybil - only this reporter
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'r1', created_at: '2026-01-01T00:00:00Z' }] });
      // Query 3: has contributions
      mockPool.query.mockResolvedValueOnce({ rows: [{ chunk_count: 10, message_count: 5 }] });
      // Query 4: no similar claims
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await detectCoordination({
        chunkId: 'chunk-1',
        reporterId: 'reporter-1',
        reason: 'Unique and legitimate copyright claim with specific evidence',
      });

      expect(result.isCoordinated).toBe(false);
      expect(result.signals).toEqual([]);
    });

    it('combines multiple signals', async () => {
      // Query 1: author targeting - 3 reporters total
      mockPool.query.mockResolvedValueOnce({ rows: [{ reporter_count: 2 }] });
      // Query 2: sybil - created within 24h
      mockPool.query.mockResolvedValueOnce({ rows: [
        { id: 'r1', created_at: '2026-03-29T10:00:00Z' },
        { id: 'r2', created_at: '2026-03-29T12:00:00Z' },
        { id: 'r3', created_at: '2026-03-29T14:00:00Z' },
      ]});
      // Query 3: report-only
      mockPool.query.mockResolvedValueOnce({ rows: [{ chunk_count: 0, message_count: 0 }] });
      // Query 4: copy-paste
      mockPool.query.mockResolvedValueOnce({ rows: [
        { reason: 'copyright infringement detected in this content', flagged_by: 'r2' },
      ]});

      const result = await detectCoordination({
        chunkId: 'chunk-1',
        reporterId: 'r3',
        reason: 'copyright infringement detected in this content',
      });

      expect(result.isCoordinated).toBe(true);
      expect(result.signals.length).toBeGreaterThanOrEqual(3);
    });
  });
});
