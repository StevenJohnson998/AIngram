jest.mock('../../config/database');

const { getPool } = require('../../config/database');
const { getRecentContributions, renderForPrompt } = require('../mini-working-set');

describe('mini-working-set', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('getRecentContributions', () => {
    it('returns empty array when accountId is falsy', async () => {
      const r1 = await getRecentContributions(null);
      const r2 = await getRecentContributions('');
      const r3 = await getRecentContributions(undefined);
      expect(r1).toEqual([]);
      expect(r2).toEqual([]);
      expect(r3).toEqual([]);
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('queries chunks by created_by and maps rows', async () => {
      const now = new Date('2026-04-14T10:00:00Z');
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'c1', title: 'Transformers', subtitle: 'Attention mechanism', created_at: now },
          { id: 'c2', title: 'HNSW', subtitle: null, created_at: now },
        ],
      });

      const out = await getRecentContributions('acc-1');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM chunks'),
        ['acc-1', 5]
      );
      expect(out).toEqual([
        { id: 'c1', title: 'Transformers', subtitle: 'Attention mechanism', createdAt: now },
        { id: 'c2', title: 'HNSW', subtitle: null, createdAt: now },
      ]);
    });

    it('honours custom limit', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      await getRecentContributions('acc-1', { limit: 12 });
      expect(mockPool.query.mock.calls[0][1]).toEqual(['acc-1', 12]);
    });
  });

  describe('renderForPrompt', () => {
    it('returns empty string for empty or non-array input', () => {
      expect(renderForPrompt([])).toBe('');
      expect(renderForPrompt(null)).toBe('');
      expect(renderForPrompt(undefined)).toBe('');
      expect(renderForPrompt('not an array')).toBe('');
    });

    it('renders a bullet list with titles, subtitles and dates', () => {
      const out = renderForPrompt([
        { title: 'Transformers', subtitle: 'Attention mechanism', createdAt: new Date('2026-04-14T10:00:00Z') },
        { title: 'HNSW', subtitle: null, createdAt: '2026-04-12T08:00:00Z' },
      ]);
      expect(out).toMatch(/^Your recent contributions/);
      expect(out).toContain('- Transformers — Attention mechanism [2026-04-14]');
      expect(out).toContain('- HNSW [2026-04-12]');
    });

    it('uses (untitled) when title is missing', () => {
      const out = renderForPrompt([{ subtitle: 'x', createdAt: new Date('2026-04-14T10:00:00Z') }]);
      expect(out).toContain('- (untitled) — x [2026-04-14]');
    });
  });
});
