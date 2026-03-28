jest.mock('../../config/database');
jest.mock('../flag');

const { getPool } = require('../../config/database');
const flagService = require('../flag');
const abuseDetection = require('../abuse-detection');

describe('abuse detection service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('checkTemporalBurst', () => {
    it('creates flags for accounts with >10 votes in 5 min on same topic', async () => {
      // Detection query
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { account_id: 'acc-1', topic_id: 'topic-1', vote_count: 15 },
          { account_id: 'acc-2', topic_id: 'topic-2', vote_count: 12 },
        ],
      });
      // Idempotence checks (no existing flags)
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // acc-1
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // acc-2
      flagService.createFlag.mockResolvedValue({ id: 'flag-auto' });

      const flags = await abuseDetection.checkTemporalBurst();

      expect(flags).toHaveLength(2);
      expect(flagService.createFlag).toHaveBeenCalledTimes(2);
      expect(flagService.createFlag).toHaveBeenCalledWith({
        reporterId: 'acc-1',
        targetType: 'account',
        targetId: 'acc-1',
        reason: expect.stringContaining('15 votes on topic topic-1'),
        detectionType: 'temporal_burst',
      });
    });

    it('skips flag creation when recent flag already exists (idempotence)', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ account_id: 'acc-1', topic_id: 'topic-1', vote_count: 15 }],
      });
      // Idempotence check returns existing flag
      mockPool.query.mockResolvedValueOnce({ rows: [{ 1: 1 }] });

      const flags = await abuseDetection.checkTemporalBurst();

      expect(flags).toHaveLength(0);
      expect(flagService.createFlag).not.toHaveBeenCalled();
    });

    it('returns empty array when no bursts detected', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const flags = await abuseDetection.checkTemporalBurst();

      expect(flags).toHaveLength(0);
      expect(flagService.createFlag).not.toHaveBeenCalled();
    });

    it('queries votes from last 5 minutes using LATERAL JOIN for topic resolution', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await abuseDetection.checkTemporalBurst();

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain("interval '5 minutes'");
      expect(query).toContain('HAVING COUNT(*) > 10');
      expect(query).toContain('COALESCE(m.topic_id, ct.topic_id)');
      expect(query).toContain('chunk_topics');
    });
  });

  describe('checkTopicConcentration', () => {
    it('creates flags for accounts with 30+ votes on <2 topics', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ account_id: 'acc-1', vote_count: 45, topic_count: 1 }],
      });
      // Idempotence check
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      flagService.createFlag.mockResolvedValue({ id: 'flag-auto' });

      const flags = await abuseDetection.checkTopicConcentration();

      expect(flags).toHaveLength(1);
      expect(flagService.createFlag).toHaveBeenCalledWith({
        reporterId: 'acc-1',
        targetType: 'account',
        targetId: 'acc-1',
        reason: expect.stringContaining('45 votes on only 1 distinct topic'),
        detectionType: 'topic_concentration',
      });
    });

    it('uses LATERAL JOIN to resolve topics from both messages and chunks', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await abuseDetection.checkTopicConcentration();

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('COALESCE(m.topic_id, ct.topic_id)');
      expect(query).toContain('chunk_topics');
    });

    it('returns empty when no concentration detected', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const flags = await abuseDetection.checkTopicConcentration();

      expect(flags).toHaveLength(0);
    });
  });

  describe('checkCreatorClustering', () => {
    it('returns empty array (stub)', async () => {
      const flags = await abuseDetection.checkCreatorClustering();
      expect(flags).toEqual([]);
    });
  });

  describe('checkNetworkClustering', () => {
    it('returns empty array (stub)', async () => {
      const flags = await abuseDetection.checkNetworkClustering();
      expect(flags).toEqual([]);
    });
  });

  describe('runAllDetections', () => {
    it('calls all detection methods and aggregates results', async () => {
      // temporal burst: 1 detection
      mockPool.query.mockResolvedValueOnce({
        rows: [{ account_id: 'acc-1', topic_id: 'topic-1', vote_count: 15 }],
      });
      // idempotence check for temporal burst
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      // topic concentration: none
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      flagService.createFlag.mockResolvedValue({ id: 'flag-auto' });

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const results = await abuseDetection.runAllDetections();

      expect(results.temporalBurst).toHaveLength(1);
      expect(results.topicConcentration).toHaveLength(0);
      expect(results.creatorClustering).toHaveLength(0);
      expect(results.networkClustering).toHaveLength(0);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('1 flags created'));

      consoleSpy.mockRestore();
    });
  });
});
