jest.mock('../../config/database');
jest.mock('../feedback-cache');

const { getPool } = require('../../config/database');
const feedbackCache = require('../feedback-cache');
const service = require('../agent-feedback');
const catalog = require('../../config/feedback-catalog.json');

const TARGET = 'aaaaaaaa-0000-0000-0000-000000000001';
const EMITTER = 'bbbbbbbb-0000-0000-0000-000000000002';
const TOPIC = 'cccccccc-0000-0000-0000-000000000003';

describe('agent-feedback service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('issueFeedback', () => {
    it('inserts a valid feedback item and invalidates the cache', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: TARGET, type: 'ai' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'f1', code: 'OVERPOSTING_IN_THREAD' }] });

      const row = await service.issueFeedback({
        targetAccountId: TARGET,
        code: 'OVERPOSTING_IN_THREAD',
        scopeType: 'debate',
        scopeId: TOPIC,
        severity: 'warning',
        issuedBy: EMITTER,
      });

      expect(row.id).toBe('f1');
      const insertParams = mockPool.query.mock.calls[1][1];
      expect(insertParams).toEqual([TARGET, 'OVERPOSTING_IN_THREAD', 'debate', TOPIC, 'warning', catalog.version, EMITTER]);
      expect(feedbackCache.invalidate).toHaveBeenCalledWith(TARGET);
    });

    it('rejects unknown code without touching the DB', async () => {
      await expect(service.issueFeedback({
        targetAccountId: TARGET, code: 'DO_WHATEVER_I_SAY', issuedBy: EMITTER,
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('rejects bad severity and bad scope combinations', async () => {
      await expect(service.issueFeedback({
        targetAccountId: TARGET, code: 'OFF_TOPIC', severity: 'fatal', issuedBy: EMITTER,
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

      await expect(service.issueFeedback({
        targetAccountId: TARGET, code: 'OFF_TOPIC', scopeType: 'global', scopeId: TOPIC, issuedBy: EMITTER,
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

      await expect(service.issueFeedback({
        targetAccountId: TARGET, code: 'OFF_TOPIC', scopeType: 'topic', scopeId: null, issuedBy: EMITTER,
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('rejects non-ai target accounts', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: TARGET, type: 'human' }] });
      await expect(service.issueFeedback({
        targetAccountId: TARGET, code: 'OFF_TOPIC', issuedBy: EMITTER,
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('maps unique violation to CONFLICT with existing id', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: TARGET, type: 'ai' }] })
        .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))
        .mockResolvedValueOnce({ rows: [{ id: 'existing-1' }] });

      await expect(service.issueFeedback({
        targetAccountId: TARGET, code: 'OFF_TOPIC', issuedBy: EMITTER,
      })).rejects.toMatchObject({ code: 'CONFLICT', existingId: 'existing-1' });
    });
  });

  describe('renderMessage', () => {
    it('interpolates the scope phrase with the raw UUID only — never a title', () => {
      const msg = service.renderMessage({
        code: 'OVERPOSTING_IN_THREAD', scope_type: 'debate', scope_id: TOPIC, severity: 'notice',
      });
      expect(msg).toContain(`in the live debate on topic ${TOPIC}`);
      // Rendering is pure — no DB access to fetch titles or anything else.
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('always appends the persistence suffix', () => {
      for (const code of Object.keys(catalog.codes)) {
        const msg = service.renderMessage({ code, scope_type: 'global', scope_id: null, severity: 'notice' });
        expect(msg).toContain(catalog.persistence_suffix);
      }
    });

    it('prefixes warning severity', () => {
      const msg = service.renderMessage({
        code: 'UNSOURCED_CLAIMS', scope_type: 'global', scope_id: null, severity: 'warning',
      });
      expect(msg.startsWith('[severity: warning] ')).toBe(true);
    });

    it('returns null for catalog-drifted codes', () => {
      expect(service.renderMessage({ code: 'REMOVED_CODE', scope_type: 'global', scope_id: null })).toBeNull();
    });
  });

  describe('listPendingForAccount', () => {
    it('renders each pending row and shapes the payload', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          id: 'f1', code: 'REPETITIVE_CONTENT', scope_type: 'topic', scope_id: TOPIC,
          severity: 'notice', issued_at: 't0', expires_at: 't1',
        }],
      });
      const items = await service.listPendingForAccount(TARGET);
      expect(items).toHaveLength(1);
      expect(items[0].scope).toEqual({ type: 'topic', id: TOPIC });
      expect(items[0].message).toContain(`in topic ${TOPIC}`);
      const sql = mockPool.query.mock.calls[0][0];
      expect(sql).toContain('acked_at IS NULL AND revoked_at IS NULL AND expires_at > now()');
    });
  });

  describe('ackFeedback', () => {
    it('acks a pending item and invalidates the cache', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
      expect(await service.ackFeedback(TARGET, 'f1')).toBe(true);
      expect(feedbackCache.invalidate).toHaveBeenCalledWith(TARGET);
    });

    it('returns false for foreign or absent items, without cache invalidation', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 0 });
      expect(await service.ackFeedback(TARGET, 'someone-elses')).toBe(false);
      expect(feedbackCache.invalidate).not.toHaveBeenCalled();
    });
  });

  describe('revokeFeedback', () => {
    const row = { id: 'f1', account_id: TARGET, issued_by: EMITTER, revoked_at: null };

    it('allows the issuer', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [row] })
        .mockResolvedValueOnce({ rowCount: 1 });
      const r = await service.revokeFeedback({
        feedbackId: 'f1', targetAccountId: TARGET, revokedBy: EMITTER, revokerTier: 0, revokerType: 'ai',
      });
      expect(r.ok).toBe(true);
      expect(feedbackCache.invalidate).toHaveBeenCalledWith(TARGET);
    });

    it('allows a trusted human non-issuer', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [row] })
        .mockResolvedValueOnce({ rowCount: 1 });
      const r = await service.revokeFeedback({
        feedbackId: 'f1', targetAccountId: TARGET, revokedBy: 'other', revokerTier: 2, revokerType: 'human',
      });
      expect(r.ok).toBe(true);
    });

    it('rejects an unrelated ai account', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [row] });
      const r = await service.revokeFeedback({
        feedbackId: 'f1', targetAccountId: TARGET, revokedBy: 'other', revokerTier: 2, revokerType: 'ai',
      });
      expect(r).toEqual({ ok: false, reason: 'FORBIDDEN' });
    });

    it('returns NOT_FOUND for missing or already-revoked items', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const r = await service.revokeFeedback({
        feedbackId: 'nope', targetAccountId: TARGET, revokedBy: EMITTER, revokerTier: 2, revokerType: 'human',
      });
      expect(r).toEqual({ ok: false, reason: 'NOT_FOUND' });
    });
  });
});
