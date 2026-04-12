jest.mock('../../config/database', () => {
  const queryMock = jest.fn();
  return {
    getPool: () => ({ query: queryMock }),
    __queryMock: queryMock,
  };
});

const { __queryMock } = require('../../config/database');
const {
  isAccountTooYoung,
  getRelatedAccountsByIp,
  getCreatorClusterSize,
  detectCreatorCluster,
} = require('../abuse-detection');

describe('S5 Sybil helpers', () => {
  beforeEach(() => {
    __queryMock.mockReset();
  });

  describe('isAccountTooYoung', () => {
    it('returns true when account row not found (unknown = treat as young)', async () => {
      __queryMock.mockResolvedValueOnce({ rows: [] });
      const result = await isAccountTooYoung('missing-id', 7);
      expect(result).toBe(true);
    });

    it('returns false when account is older than minDays', async () => {
      // SQL alias `old_enough` reflects whether `created_at < now() - interval`
      // i.e. true when old enough (NOT too young)
      __queryMock.mockResolvedValueOnce({ rows: [{ old_enough: true }] });
      const result = await isAccountTooYoung('id-1', 7);
      expect(result).toBe(false);
    });

    it('returns true when account is younger than minDays', async () => {
      __queryMock.mockResolvedValueOnce({ rows: [{ old_enough: false }] });
      const result = await isAccountTooYoung('id-1', 7);
      expect(result).toBe(true);
    });

    it('passes minDays as a string interval to avoid SQL injection', async () => {
      __queryMock.mockResolvedValueOnce({ rows: [{ old_enough: true }] });
      await isAccountTooYoung('id-1', 30);
      expect(__queryMock).toHaveBeenCalledWith(
        expect.stringContaining(`($2 || ' days')::interval`),
        ['id-1', '30']
      );
    });
  });

  describe('getRelatedAccountsByIp', () => {
    it('returns empty array when no related accounts', async () => {
      __queryMock.mockResolvedValueOnce({ rows: [] });
      const result = await getRelatedAccountsByIp('id-1');
      expect(result).toEqual([]);
    });

    it('returns related accounts excluding the input', async () => {
      const fake = [
        { id: 'id-2', name: 'alice', created_at: '2026-04-01', status: 'active' },
        { id: 'id-3', name: 'bob', created_at: '2026-04-02', status: 'active' },
      ];
      __queryMock.mockResolvedValueOnce({ rows: fake });
      const result = await getRelatedAccountsByIp('id-1');
      expect(result).toHaveLength(2);
      expect(result.map(r => r.name)).toEqual(['alice', 'bob']);
    });

    it('SQL filters out NULL creator_ip and self-match', async () => {
      __queryMock.mockResolvedValueOnce({ rows: [] });
      await getRelatedAccountsByIp('id-1');
      const sql = __queryMock.mock.calls[0][0];
      expect(sql).toContain('creator_ip IS NOT NULL');
      expect(sql).toContain('a2.id != a1.id');
    });
  });

  describe('getCreatorClusterSize', () => {
    it('returns the count of related accounts', async () => {
      __queryMock.mockResolvedValueOnce({
        rows: [
          { id: 'id-2', name: 'a', created_at: '2026', status: 'active' },
          { id: 'id-3', name: 'b', created_at: '2026', status: 'active' },
          { id: 'id-4', name: 'c', created_at: '2026', status: 'active' },
        ],
      });
      const size = await getCreatorClusterSize('id-1');
      expect(size).toBe(3);
    });

    it('returns 0 when no relations', async () => {
      __queryMock.mockResolvedValueOnce({ rows: [] });
      const size = await getCreatorClusterSize('id-1');
      expect(size).toBe(0);
    });
  });

  describe('detectCreatorCluster', () => {
    it('returns null when below threshold', async () => {
      __queryMock.mockResolvedValueOnce({
        rows: Array.from({ length: 3 }, (_, i) => ({
          id: `id-${i}`, name: `n${i}`, created_at: '2026', status: 'active',
        })),
      });
      const result = await detectCreatorCluster('id-1', 5);
      expect(result).toBeNull();
    });

    it('returns cluster details when at or above threshold', async () => {
      __queryMock.mockResolvedValueOnce({
        rows: Array.from({ length: 6 }, (_, i) => ({
          id: `id-${i}`, name: `n${i}`, created_at: '2026', status: 'active',
        })),
      });
      const result = await detectCreatorCluster('id-1', 5);
      expect(result).not.toBeNull();
      expect(result.size).toBe(6);
      expect(result.related).toHaveLength(6);
      expect(result.related[0]).toHaveProperty('id');
      expect(result.related[0]).toHaveProperty('name');
      expect(result.related[0]).toHaveProperty('createdAt');
      expect(result.related[0]).toHaveProperty('status');
    });

    it('default threshold is 5', async () => {
      __queryMock.mockResolvedValueOnce({
        rows: Array.from({ length: 4 }, (_, i) => ({
          id: `id-${i}`, name: 'n', created_at: '2026', status: 'active',
        })),
      });
      const result = await detectCreatorCluster('id-1');
      expect(result).toBeNull();
    });
  });
});
