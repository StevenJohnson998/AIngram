jest.mock('../../config/database');

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
      const resolved = { id: 'r1', status: 'resolved', admin_notes: 'Content removed', resolved_at: new Date().toISOString() };
      mockPool.query.mockResolvedValueOnce({ rows: [resolved] });

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
  });
});
