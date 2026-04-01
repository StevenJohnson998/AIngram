jest.mock('../../config/database');
jest.mock('../../config/protocol', () => ({
  COPYRIGHT_PRIORITY_TOPIC_THRESHOLD: 3,
  COPYRIGHT_PRIORITY_REPORTER_THRESHOLD: 5,
  REPORTER_SUSPENSION_FP_THRESHOLD: 0.6,
  REPORTER_SUSPENSION_MIN_REPORTS: 10,
  REPORTER_SUSPENSION_DURATION_MS: 30 * 24 * 60 * 60 * 1000,
}));
jest.mock('../dmca-coordination', () => ({
  detectCoordination: jest.fn().mockResolvedValue({ isCoordinated: false, signals: [], details: {} }),
}));

const { getPool } = require('../../config/database');
const copyrightService = require('../copyright-review');

describe('copyright-review service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('createCopyrightReview', () => {
    it('creates a review for a valid chunk', async () => {
      const review = { id: 'cr-1', chunk_id: 'chunk-1', status: 'pending', priority: 'normal' };

      // 1. chunk exists
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'chunk-1', status: 'published' }] });
      // 2. suspension check
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // 3. no existing pending review
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // 4. res judicata check (no cleared reviews)
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // 5. topic volume check
      mockPool.query.mockResolvedValueOnce({ rows: [{ topic_id: 'topic-1' }] });
      // 6. topic volume count
      mockPool.query.mockResolvedValueOnce({ rows: [{ cnt: 0 }] });
      // 7. reporter volume check
      mockPool.query.mockResolvedValueOnce({ rows: [{ cnt: 0 }] });
      // 8. insert
      mockPool.query.mockResolvedValueOnce({ rows: [review] });
      // 9. activity log
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await copyrightService.createCopyrightReview({
        chunkId: 'chunk-1',
        flaggedBy: 'acc-1',
        reason: 'This content appears to be copied from a published paper',
      });

      expect(result).toEqual(review);
    });

    it('rejects when reporter is suspended (DSA Art. 23)', async () => {
      // 1. chunk exists
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'chunk-1' }] });
      // 2. suspension check returns active suspension
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'susp-1' }] });

      await expect(
        copyrightService.createCopyrightReview({
          chunkId: 'chunk-1',
          flaggedBy: 'acc-1',
          reason: 'Copied content from somewhere',
        })
      ).rejects.toThrow('suspended');
    });

    it('rejects re-filing of similar claim by same reporter (res judicata)', async () => {
      // 1. chunk exists
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'chunk-1' }] });
      // 2. no suspension
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // 3. no pending review
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // 4. res judicata: same reporter has a cleared review with similar reason
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'cr-old', reason: 'This content copies text from the Stanford AI Index Report 2025' }],
      });

      await expect(
        copyrightService.createCopyrightReview({
          chunkId: 'chunk-1',
          flaggedBy: 'acc-1',
          reason: 'Content copied from Stanford AI Index Report published in 2025',
        })
      ).rejects.toThrow('substantially similar');
    });

    it('allows re-filing by same reporter with genuinely different claim (priority high)', async () => {
      const review = { id: 'cr-2', chunk_id: 'chunk-1', status: 'pending', priority: 'high' };

      // 1. chunk exists
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'chunk-1' }] });
      // 2. no suspension
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // 3. no pending review
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // 4. res judicata: cleared review with DIFFERENT reason → priority set to 'high'
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'cr-old', reason: 'This content copies text from the Stanford AI Index Report 2025' }],
      });
      // 5. topic volume check (chunk_topics)
      mockPool.query.mockResolvedValueOnce({ rows: [{ topic_id: 'topic-1' }] });
      // 6. topic volume count
      mockPool.query.mockResolvedValueOnce({ rows: [{ cnt: 0 }] });
      // 7. reporter volume count (skipped because priority already 'high' — but code still checks)
      // Actually, the code checks `if (priority === 'normal')` for reporter volume, so it skips
      // 8. insert
      mockPool.query.mockResolvedValueOnce({ rows: [review] });
      // 9. activity log
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await copyrightService.createCopyrightReview({
        chunkId: 'chunk-1',
        flaggedBy: 'acc-1',
        reason: 'This infringes my patent on neural network architecture published by MIT Press',
      });

      expect(result.priority).toBe('high');
    });

    it('rejects short reason', async () => {
      await expect(
        copyrightService.createCopyrightReview({
          chunkId: 'chunk-1',
          reason: 'short',
        })
      ).rejects.toThrow('at least 10 characters');
    });

    it('rejects non-existent chunk', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        copyrightService.createCopyrightReview({
          chunkId: 'missing',
          reason: 'This content is copied from somewhere',
        })
      ).rejects.toThrow('Chunk not found');
    });

    it('rejects duplicate pending review', async () => {
      // chunk exists
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'chunk-1' }] });
      // existing pending review
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'existing-review' }] });

      await expect(
        copyrightService.createCopyrightReview({
          chunkId: 'chunk-1',
          reason: 'This is potentially infringing content',
        })
      ).rejects.toThrow('already pending');
    });
  });

  describe('listCopyrightReviews', () => {
    it('returns paginated results', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 5 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'cr-1' }, { id: 'cr-2' }] });

      const result = await copyrightService.listCopyrightReviews({ status: 'pending', page: 1, limit: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({ page: 1, limit: 2, total: 5 });
    });
  });

  describe('assignReview', () => {
    it('assigns a reviewer to a pending review', async () => {
      const assigned = { id: 'cr-1', status: 'assigned', assigned_to: 'reviewer-1' };
      mockPool.query.mockResolvedValueOnce({ rows: [assigned] });

      const result = await copyrightService.assignReview('cr-1', { assignedTo: 'reviewer-1' });
      expect(result.status).toBe('assigned');
    });

    it('rejects assignment on already assigned review', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ status: 'assigned' }] });

      await expect(
        copyrightService.assignReview('cr-1', { assignedTo: 'reviewer-1' })
      ).rejects.toThrow('cannot be assigned');
    });
  });

  describe('resolveCopyrightReview', () => {
    it('resolves with verdict "clear" and decreases reporter rep', async () => {
      const review = { id: 'cr-1', chunk_id: 'chunk-1', flagged_by: 'reporter-1', status: 'resolved', verdict: 'clear' };

      // UPDATE → resolved
      mockPool.query.mockResolvedValueOnce({ rows: [review] });
      // UPDATE reputation_copyright (false positive)
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // checkAndSuspendReporter: count reports
      mockPool.query.mockResolvedValueOnce({ rows: [{ total: 3, false_positives: 1 }] });
      // Activity log
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await copyrightService.resolveCopyrightReview('cr-1', {
        verdict: 'clear',
        resolvedBy: 'admin-1',
      });

      expect(result.verdict).toBe('clear');
      // Verify reputation update was called
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('reputation_copyright'),
        [-0.05, 'reporter-1']
      );
    });

    it('resolves with verdict "rewrite_required" and hides chunk', async () => {
      const review = { id: 'cr-1', chunk_id: 'chunk-1', flagged_by: null, status: 'resolved', verdict: 'rewrite_required' };

      mockPool.query.mockResolvedValueOnce({ rows: [review] });
      // UPDATE chunks hidden=true
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // Activity log
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await copyrightService.resolveCopyrightReview('cr-1', {
        verdict: 'rewrite_required',
        resolvedBy: 'admin-1',
      });

      expect(result.verdict).toBe('rewrite_required');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('hidden = true'),
        ['chunk-1']
      );
    });

    it('resolves with verdict "takedown" and retracts chunk', async () => {
      const review = { id: 'cr-1', chunk_id: 'chunk-1', flagged_by: 'reporter-1', status: 'resolved', verdict: 'takedown' };

      mockPool.query.mockResolvedValueOnce({ rows: [review] });
      // UPDATE chunks retracted + hidden
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // SELECT chunk author
      mockPool.query.mockResolvedValueOnce({ rows: [{ created_by: 'author-1' }] });
      // UPDATE author reputation
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // Activity log
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await copyrightService.resolveCopyrightReview('cr-1', {
        verdict: 'takedown',
        resolvedBy: 'admin-1',
      });

      expect(result.verdict).toBe('takedown');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("retract_reason = 'copyright'"),
        ['chunk-1']
      );
    });

    it('rejects invalid verdict', async () => {
      await expect(
        copyrightService.resolveCopyrightReview('cr-1', { verdict: 'invalid', resolvedBy: 'admin-1' })
      ).rejects.toThrow('Verdict must be one of');
    });

    it('rejects resolution on already resolved review', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ status: 'resolved' }] });

      await expect(
        copyrightService.resolveCopyrightReview('cr-1', { verdict: 'clear', resolvedBy: 'admin-1' })
      ).rejects.toThrow('already resolved');
    });
  });

  describe('verbatimSearch', () => {
    it('finds chunks containing exact text', async () => {
      const matches = [{ id: 'chunk-1', content: 'Some copied text here', match_position: 5 }];
      mockPool.query.mockResolvedValueOnce({ rows: matches });

      const result = await copyrightService.verbatimSearch('Some copied text here and more characters to pass minimum');

      expect(result).toHaveLength(1);
      expect(result[0].match_position).toBe(5);
    });

    it('rejects short search text', async () => {
      await expect(
        copyrightService.verbatimSearch('too short')
      ).rejects.toThrow('at least 30 characters');
    });
  });

  describe('checkSources', () => {
    it('returns source resolution status', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 's1', source_url: 'https://doi.org/10.1234/test', source_description: 'Test paper' },
          { id: 's2', source_url: 'https://example.com/article', source_description: null },
          { id: 's3', source_url: null, source_description: 'Verbal communication' },
        ],
      });

      const result = await copyrightService.checkSources('chunk-1');

      expect(result.sources).toHaveLength(3);
      expect(result.sources[0].type).toBe('doi');
      expect(result.sources[0].doi).toBe('10.1234/test');
      expect(result.sources[1].type).toBe('url');
      expect(result.sources[2].type).toBe('description_only');
      expect(result.sources[2].status).toBe('unverifiable');
    });

    it('warns when no sources exist', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await copyrightService.checkSources('chunk-1');
      expect(result.warning).toContain('No sources');
    });
  });
});
