jest.mock('../../config/database');
jest.mock('../../config/protocol', () => ({
  T_COUNTER_NOTICE_DELAY_MS: 14 * 24 * 60 * 60 * 1000,
  MIN_REP_COPYRIGHT_FAST_TAKEDOWN: 0.8,
}));

const { getPool } = require('../../config/database');
const reportService = require('../report');

describe('report service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('createReport', () => {
    it('creates a report with valid input', async () => {
      const report = {
        id: 'rep-1',
        content_id: '550e8400-e29b-41d4-a716-446655440000',
        content_type: 'chunk',
        status: 'pending',
        created_at: new Date().toISOString(),
      };

      // Existence check
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: report.content_id }] });
      // Insert
      mockPool.query.mockResolvedValueOnce({ rows: [report] });

      const result = await reportService.createReport({
        contentId: report.content_id,
        contentType: 'chunk',
        reason: 'This content infringes my copyright on XYZ',
        reporterEmail: 'reporter@example.com',
      });

      expect(result).toEqual(report);
      expect(mockPool.query).toHaveBeenCalledTimes(2);
      expect(mockPool.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('SELECT id FROM chunks'),
        [report.content_id]
      );
      expect(mockPool.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('INSERT INTO reports'),
        [report.content_id, 'chunk', 'This content infringes my copyright on XYZ', 'reporter@example.com']
      );
    });

    it('rejects invalid content type', async () => {
      await expect(
        reportService.createReport({
          contentId: '550e8400-e29b-41d4-a716-446655440000',
          contentType: 'invalid',
          reason: 'Some valid reason text here',
          reporterEmail: 'test@example.com',
        })
      ).rejects.toThrow('contentType must be one of');
    });

    it('rejects short reason', async () => {
      await expect(
        reportService.createReport({
          contentId: '550e8400-e29b-41d4-a716-446655440000',
          contentType: 'chunk',
          reason: 'short',
          reporterEmail: 'test@example.com',
        })
      ).rejects.toThrow('minimum 10 characters');
    });

    it('rejects invalid email', async () => {
      await expect(
        reportService.createReport({
          contentId: '550e8400-e29b-41d4-a716-446655440000',
          contentType: 'chunk',
          reason: 'This is a valid reason text',
          reporterEmail: 'not-an-email',
        })
      ).rejects.toThrow('valid reporter email');
    });

    it('returns NOT_FOUND if content does not exist', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        reportService.createReport({
          contentId: '550e8400-e29b-41d4-a716-446655440000',
          contentType: 'topic',
          reason: 'This content should not be here',
          reporterEmail: 'test@example.com',
        })
      ).rejects.toThrow('topic not found');
    });
  });

  describe('listReports', () => {
    it('returns paginated pending reports', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 3 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'r1' }, { id: 'r2' }] });

      const result = await reportService.listReports({ status: 'pending', page: 1, limit: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({ page: 1, limit: 2, total: 3 });
    });
  });

  describe('resolveReport', () => {
    it('resolves a pending report', async () => {
      const resolved = { id: 'r1', content_id: 'chunk-1', content_type: 'chunk', status: 'resolved', admin_notes: 'Content removed', resolved_at: new Date().toISOString() };
      mockPool.query
        .mockResolvedValueOnce({ rows: [resolved] }) // UPDATE reports
        .mockResolvedValueOnce({ rows: [] }); // INSERT activity_log

      const result = await reportService.resolveReport('r1', {
        status: 'resolved',
        adminNotes: 'Content removed',
        resolvedBy: 'admin-1',
      });

      expect(result.status).toBe('resolved');
    });

    it('rejects invalid resolution status', async () => {
      await expect(
        reportService.resolveReport('r1', { status: 'pending', resolvedBy: 'admin-1' })
      ).rejects.toThrow('status must be resolved or dismissed');
    });

    it('returns NOT_FOUND for already resolved report', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        reportService.resolveReport('r1', { status: 'resolved', resolvedBy: 'admin-1' })
      ).rejects.toThrow('not found or already resolved');
    });

    it('emits report_resolved activity entry on resolution', async () => {
      const resolved = { id: 'r1', content_id: 'chunk-1', content_type: 'chunk', status: 'resolved' };
      mockPool.query
        .mockResolvedValueOnce({ rows: [resolved] })
        .mockResolvedValueOnce({ rows: [] });

      await reportService.resolveReport('r1', { status: 'resolved', resolvedBy: 'admin-1' });

      const activityCall = mockPool.query.mock.calls.find(c => /INSERT INTO activity_log/.test(c[0]));
      expect(activityCall).toBeDefined();
      expect(activityCall[1]).toEqual([
        'admin-1',
        'report_resolved',
        'chunk',
        'chunk-1',
        JSON.stringify({ report_id: 'r1' }),
      ]);
    });

    it('emits report_dismissed activity entry on dismissal', async () => {
      const dismissed = { id: 'r2', content_id: 'topic-42', content_type: 'topic', status: 'dismissed' };
      mockPool.query
        .mockResolvedValueOnce({ rows: [dismissed] })
        .mockResolvedValueOnce({ rows: [] });

      await reportService.resolveReport('r2', { status: 'dismissed', resolvedBy: 'admin-2' });

      const activityCall = mockPool.query.mock.calls.find(c => /INSERT INTO activity_log/.test(c[0]));
      expect(activityCall).toBeDefined();
      expect(activityCall[1][1]).toBe('report_dismissed');
      expect(activityCall[1][2]).toBe('topic');
      expect(activityCall[1][3]).toBe('topic-42');
    });
  });

  describe('takedownReport', () => {
    it('takes down a chunk report when reviewer has high copyright rep', async () => {
      const report = {
        id: 'r1',
        content_id: 'chunk-1',
        content_type: 'chunk',
        status: 'taken_down',
        reason: 'Copyright infringement',
      };

      // UPDATE reports → taken_down
      mockPool.query.mockResolvedValueOnce({ rows: [report] });
      // UPDATE chunks hidden=true
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // SELECT chunk author
      mockPool.query.mockResolvedValueOnce({ rows: [{ created_by: 'author-1' }] });
      // INSERT activity_log (public)
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // INSERT activity_log (author notification)
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await reportService.takedownReport('r1', {
        takenDownBy: 'admin-1',
        reviewerCopyrightRep: 0.9,
      });

      expect(result.status).toBe('taken_down');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('hidden = true'),
        ['chunk-1']
      );
    });

    it('rejects fast-track takedown when reviewer copyright rep too low', async () => {
      await expect(
        reportService.takedownReport('r1', {
          takenDownBy: 'admin-1',
          reviewerCopyrightRep: 0.5,
        })
      ).rejects.toThrow('reputation_copyright >= 0.8');
    });

    it('rejects takedown on non-chunk report', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ status: 'pending', content_type: 'topic' }] });

      await expect(
        reportService.takedownReport('r1', { takenDownBy: 'admin-1', reviewerCopyrightRep: 0.9 })
      ).rejects.toThrow('only applies to chunk reports');
    });

    it('rejects takedown on already resolved report', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ status: 'resolved', content_type: 'chunk' }] });

      await expect(
        reportService.takedownReport('r1', { takenDownBy: 'admin-1', reviewerCopyrightRep: 0.9 })
      ).rejects.toThrow('cannot be taken down');
    });

    it('returns NOT_FOUND for non-existent report', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        reportService.takedownReport('r1', { takenDownBy: 'admin-1', reviewerCopyrightRep: 0.9 })
      ).rejects.toThrow('Report not found');
    });
  });

  describe('autoHideFromReport', () => {
    it('auto-hides chunk and notifies author when review deadline exceeded', async () => {
      const report = { id: 'r1', content_id: 'chunk-1', reason: 'Potential copyright' };

      // UPDATE reports → taken_down
      mockPool.query.mockResolvedValueOnce({ rows: [report] });
      // UPDATE chunks hidden=true
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // SELECT chunk author
      mockPool.query.mockResolvedValueOnce({ rows: [{ created_by: 'author-1' }] });
      // INSERT activity_log (public)
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // INSERT activity_log (author notification)
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await reportService.autoHideFromReport('r1');
      expect(result).not.toBeNull();
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('copyright_notice_received'),
        expect.arrayContaining(['author-1'])
      );
    });

    it('returns null when report not in pending state', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const result = await reportService.autoHideFromReport('r1');
      expect(result).toBeNull();
    });
  });

  describe('counterNotice', () => {
    it('files a counter-notice on a taken-down report', async () => {
      const report = {
        id: 'r1',
        status: 'counter_noticed',
        counter_notice_email: 'author@example.com',
        restoration_eligible_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      };

      mockPool.query.mockResolvedValueOnce({ rows: [report] });

      const result = await reportService.counterNotice('r1', {
        email: 'author@example.com',
        reason: 'I am the original author and this content is my own work, published under CC BY-SA.',
      });

      expect(result.status).toBe('counter_noticed');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('counter_noticed'),
        expect.arrayContaining(['author@example.com'])
      );
    });

    it('rejects counter-notice with short reason', async () => {
      await expect(
        reportService.counterNotice('r1', { email: 'a@b.com', reason: 'Too short' })
      ).rejects.toThrow('at least 50 characters');
    });

    it('rejects counter-notice on non-taken-down report', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ status: 'pending' }] });

      await expect(
        reportService.counterNotice('r1', {
          email: 'a@b.com',
          reason: 'I am the original author and this content is my own work, published under CC BY-SA license.',
        })
      ).rejects.toThrow('only applies to taken-down reports');
    });
  });

  describe('restoreAfterCounterNotice', () => {
    it('restores a chunk after counter-notice delay', async () => {
      const report = {
        id: 'r1',
        content_id: 'chunk-1',
        status: 'restored',
        restored_at: new Date().toISOString(),
      };

      // UPDATE reports → restored
      mockPool.query.mockResolvedValueOnce({ rows: [report] });
      // UPDATE chunks hidden=false
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // INSERT activity_log
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await reportService.restoreAfterCounterNotice('r1', { restoredBy: 'admin-1' });

      expect(result.status).toBe('restored');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('hidden = false'),
        ['chunk-1']
      );
    });

    it('rejects restoration before delay has elapsed', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      mockPool.query.mockResolvedValueOnce({
        rows: [{ status: 'counter_noticed', restoration_eligible_at: new Date(Date.now() + 86400000) }],
      });

      await expect(
        reportService.restoreAfterCounterNotice('r1', { restoredBy: 'admin-1' })
      ).rejects.toThrow('delay has not elapsed');
    });

    it('rejects restoration on non-counter-noticed report', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ status: 'pending' }] });

      await expect(
        reportService.restoreAfterCounterNotice('r1', { restoredBy: 'admin-1' })
      ).rejects.toThrow('not in counter_noticed status');
    });
  });
});
