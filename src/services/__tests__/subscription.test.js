jest.mock('../../config/database');
jest.mock('../ollama');

const { getPool } = require('../../config/database');
const { generateEmbedding } = require('../ollama');
const {
  getTier,
  createSubscription,
  listMySubscriptions,
  updateSubscription,
  deleteSubscription,
  getSubscriptionById,
} = require('../subscription');

describe('subscription service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  const ACCOUNT_ID = 'acc-123';

  // --- getTier ---

  describe('getTier', () => {
    it('returns open tier when account not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const result = await getTier(ACCOUNT_ID);
      expect(result).toEqual({ tier: 'open', limit: 3 });
    });

    it('returns open tier for account with no contributions', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ reputation_contribution: null, badge_contribution: false, first_contribution_at: null }],
      });
      const result = await getTier(ACCOUNT_ID);
      expect(result).toEqual({ tier: 'open', limit: 3 });
    });

    it('returns open tier when reputation is negative', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ reputation_contribution: -1, badge_contribution: false, first_contribution_at: new Date() }],
      });
      const result = await getTier(ACCOUNT_ID);
      expect(result).toEqual({ tier: 'open', limit: 3 });
    });

    it('returns contributor tier for account with first_contribution_at and reputation >= 0', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ reputation_contribution: 5, badge_contribution: false, first_contribution_at: new Date() }],
      });
      const result = await getTier(ACCOUNT_ID);
      expect(result).toEqual({ tier: 'contributor', limit: 20 });
    });

    it('returns contributor tier when reputation is exactly 0', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ reputation_contribution: 0, badge_contribution: false, first_contribution_at: new Date() }],
      });
      const result = await getTier(ACCOUNT_ID);
      expect(result).toEqual({ tier: 'contributor', limit: 20 });
    });

    it('returns trusted tier when badge_contribution is true', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ reputation_contribution: 10, badge_contribution: true, first_contribution_at: new Date() }],
      });
      const result = await getTier(ACCOUNT_ID);
      expect(result).toEqual({ tier: 'trusted', limit: Infinity });
    });
  });

  // --- createSubscription ---

  describe('createSubscription', () => {
    const SUB_ROW = {
      id: 'sub-1',
      account_id: ACCOUNT_ID,
      type: 'topic',
      topic_id: 'topic-1',
      keyword: null,
      similarity_threshold: null,
      lang: 'en',
      notification_method: 'webhook',
      webhook_url: 'https://example.com/hook',
      active: true,
      created_at: new Date().toISOString(),
    };

    function mockTierAndCount(tier, count) {
      // getTier query
      const tierRow = {
        open: { reputation_contribution: null, badge_contribution: false, first_contribution_at: null },
        contributor: { reputation_contribution: 5, badge_contribution: false, first_contribution_at: new Date() },
        trusted: { reputation_contribution: 10, badge_contribution: true, first_contribution_at: new Date() },
      };
      mockPool.query
        .mockResolvedValueOnce({ rows: [tierRow[tier]] })
        .mockResolvedValueOnce({ rows: [{ count }] });
    }

    it('creates a topic subscription', async () => {
      mockTierAndCount('contributor', 5);
      mockPool.query.mockResolvedValueOnce({ rows: [SUB_ROW] });

      const result = await createSubscription({
        accountId: ACCOUNT_ID,
        type: 'topic',
        topicId: 'topic-1',
        lang: 'en',
        notificationMethod: 'webhook',
        webhookUrl: 'https://example.com/hook',
      });

      expect(result).toEqual(SUB_ROW);
      // INSERT query should be the 3rd call
      const insertCall = mockPool.query.mock.calls[2];
      expect(insertCall[0]).toContain('INSERT INTO subscriptions');
      expect(insertCall[1][1]).toBe('topic');
      expect(insertCall[1][2]).toBe('topic-1');
    });

    it('creates a keyword subscription', async () => {
      mockTierAndCount('contributor', 0);
      const kwRow = { ...SUB_ROW, type: 'keyword', keyword: 'machine learning', topic_id: null };
      mockPool.query.mockResolvedValueOnce({ rows: [kwRow] });

      const result = await createSubscription({
        accountId: ACCOUNT_ID,
        type: 'keyword',
        keyword: 'machine learning',
        notificationMethod: 'polling',
      });

      expect(result.type).toBe('keyword');
      expect(result.keyword).toBe('machine learning');
    });

    it('creates a vector subscription with embedding', async () => {
      mockTierAndCount('contributor', 0);
      const vecRow = { ...SUB_ROW, type: 'vector', similarity_threshold: 0.8, topic_id: null };
      mockPool.query.mockResolvedValueOnce({ rows: [vecRow] });
      generateEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);

      const result = await createSubscription({
        accountId: ACCOUNT_ID,
        type: 'vector',
        embeddingText: 'AI agents communication',
        notificationMethod: 'webhook',
        webhookUrl: 'https://example.com/hook',
      });

      expect(result.type).toBe('vector');
      expect(generateEmbedding).toHaveBeenCalledWith('AI agents communication');
      // Check embedding was serialized in INSERT
      const insertCall = mockPool.query.mock.calls[2];
      expect(insertCall[1][4]).toBe('[0.1,0.2,0.3]');
    });

    it('rejects when tier limit is reached (open tier, 3 max)', async () => {
      mockTierAndCount('open', 3);

      await expect(
        createSubscription({
          accountId: ACCOUNT_ID,
          type: 'topic',
          topicId: 'topic-1',
          notificationMethod: 'polling',
        })
      ).rejects.toThrow(/limit reached/i);
    });

    it('rejects when open tier has exactly 3 subscriptions', async () => {
      mockTierAndCount('open', 3);

      try {
        await createSubscription({
          accountId: ACCOUNT_ID,
          type: 'keyword',
          keyword: 'test keyword',
          notificationMethod: 'polling',
        });
        fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('LIMIT_REACHED');
      }
    });

    it('allows contributor up to 20 subscriptions', async () => {
      mockTierAndCount('contributor', 19);
      mockPool.query.mockResolvedValueOnce({ rows: [SUB_ROW] });

      const result = await createSubscription({
        accountId: ACCOUNT_ID,
        type: 'topic',
        topicId: 'topic-1',
        notificationMethod: 'polling',
      });

      expect(result).toBeTruthy();
    });

    it('rejects contributor at 20 subscriptions', async () => {
      mockTierAndCount('contributor', 20);

      await expect(
        createSubscription({
          accountId: ACCOUNT_ID,
          type: 'topic',
          topicId: 'topic-1',
          notificationMethod: 'polling',
        })
      ).rejects.toThrow(/limit reached/i);
    });

    it('allows trusted tier unlimited subscriptions', async () => {
      mockTierAndCount('trusted', 999);
      mockPool.query.mockResolvedValueOnce({ rows: [SUB_ROW] });

      const result = await createSubscription({
        accountId: ACCOUNT_ID,
        type: 'topic',
        topicId: 'topic-1',
        notificationMethod: 'polling',
      });

      expect(result).toBeTruthy();
    });

    it('rejects topic subscription without topicId', async () => {
      mockTierAndCount('contributor', 0);

      await expect(
        createSubscription({
          accountId: ACCOUNT_ID,
          type: 'topic',
          notificationMethod: 'polling',
        })
      ).rejects.toThrow(/topicId is required/i);
    });

    it('rejects keyword subscription with too short keyword', async () => {
      mockTierAndCount('contributor', 0);

      await expect(
        createSubscription({
          accountId: ACCOUNT_ID,
          type: 'keyword',
          keyword: 'ab',
          notificationMethod: 'polling',
        })
      ).rejects.toThrow(/3 and 255/);
    });

    it('rejects vector subscription without embeddingText', async () => {
      mockTierAndCount('contributor', 0);

      await expect(
        createSubscription({
          accountId: ACCOUNT_ID,
          type: 'vector',
          notificationMethod: 'polling',
        })
      ).rejects.toThrow(/embeddingText is required/i);
    });

    it('rejects vector subscription when embedding generation fails', async () => {
      mockTierAndCount('contributor', 0);
      generateEmbedding.mockResolvedValueOnce(null);

      await expect(
        createSubscription({
          accountId: ACCOUNT_ID,
          type: 'vector',
          embeddingText: 'test',
          notificationMethod: 'polling',
        })
      ).rejects.toThrow(/embedding/i);
    });

    it('defaults similarity threshold to 0.8 for vector type', async () => {
      mockTierAndCount('contributor', 0);
      generateEmbedding.mockResolvedValueOnce([0.1, 0.2]);
      mockPool.query.mockResolvedValueOnce({ rows: [{ ...SUB_ROW, type: 'vector', similarity_threshold: 0.8 }] });

      await createSubscription({
        accountId: ACCOUNT_ID,
        type: 'vector',
        embeddingText: 'test',
        notificationMethod: 'polling',
      });

      const insertCall = mockPool.query.mock.calls[2];
      expect(insertCall[1][5]).toBe(0.8); // similarity_threshold param
    });
  });

  // --- listMySubscriptions ---

  describe('listMySubscriptions', () => {
    it('returns paginated subscriptions', async () => {
      const rows = [{ id: 'sub-1' }, { id: 'sub-2' }];
      mockPool.query
        .mockResolvedValueOnce({ rows })
        .mockResolvedValueOnce({ rows: [{ total: 15 }] });

      const result = await listMySubscriptions(ACCOUNT_ID, { page: 2, limit: 5 });

      expect(result.data).toEqual(rows);
      expect(result.pagination).toEqual({ page: 2, limit: 5, total: 15 });
      // Check offset calculation
      const dataQuery = mockPool.query.mock.calls[0];
      expect(dataQuery[1]).toEqual([ACCOUNT_ID, 5, 5]); // limit=5, offset=5
    });
  });

  // --- updateSubscription ---

  describe('updateSubscription', () => {
    it('updates subscription fields for owner', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'sub-1', account_id: ACCOUNT_ID }] })
        .mockResolvedValueOnce({
          rows: [{ id: 'sub-1', active: false, similarity_threshold: 0.9 }],
        });

      const result = await updateSubscription('sub-1', ACCOUNT_ID, { active: false, similarityThreshold: 0.9 });

      expect(result.active).toBe(false);
    });

    it('throws NOT_FOUND for nonexistent subscription', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        updateSubscription('sub-missing', ACCOUNT_ID, { active: false })
      ).rejects.toThrow(/not found/i);
    });

    it('throws FORBIDDEN when not owner', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'sub-1', account_id: 'other-acc' }] });

      try {
        await updateSubscription('sub-1', ACCOUNT_ID, { active: false });
        fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('FORBIDDEN');
      }
    });

    it('throws VALIDATION_ERROR when no fields provided', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'sub-1', account_id: ACCOUNT_ID }] });

      try {
        await updateSubscription('sub-1', ACCOUNT_ID, {});
        fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  // --- deleteSubscription ---

  describe('deleteSubscription', () => {
    it('deletes subscription for owner', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'sub-1', account_id: ACCOUNT_ID }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      await deleteSubscription('sub-1', ACCOUNT_ID);

      expect(mockPool.query).toHaveBeenCalledTimes(2);
      const deleteCall = mockPool.query.mock.calls[1];
      expect(deleteCall[0]).toContain('DELETE');
    });

    it('throws NOT_FOUND for nonexistent subscription', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        deleteSubscription('sub-missing', ACCOUNT_ID)
      ).rejects.toThrow(/not found/i);
    });

    it('throws FORBIDDEN when not owner', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'sub-1', account_id: 'other-acc' }] });

      try {
        await deleteSubscription('sub-1', ACCOUNT_ID);
        fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('FORBIDDEN');
      }
    });
  });

  // --- getSubscriptionById ---

  describe('getSubscriptionById', () => {
    it('returns subscription when found', async () => {
      const sub = { id: 'sub-1', type: 'topic' };
      mockPool.query.mockResolvedValueOnce({ rows: [sub] });

      const result = await getSubscriptionById('sub-1');
      expect(result).toEqual(sub);
    });

    it('returns null when not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await getSubscriptionById('sub-missing');
      expect(result).toBeNull();
    });
  });
});
