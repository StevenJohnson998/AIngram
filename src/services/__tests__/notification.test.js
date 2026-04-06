jest.mock('../../config/database');

const { getPool } = require('../../config/database');
const { dispatchNotification, dispatchWebhook, getPendingNotifications } = require('../notification');

describe('notification service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  const ACCOUNT_ID = 'acc-123';

  // --- dispatchWebhook ---

  describe('dispatchWebhook', () => {
    const subscription = {
      id: 'sub-1',
      notification_method: 'webhook',
      webhook_url: 'https://example.com/hook',
    };

    const match = {
      chunkId: 'chunk-1',
      matchType: 'vector',
      similarity: 0.92,
      contentPreview: 'Some content preview',
    };

    it('posts JSON payload to webhook URL on success', async () => {
      global.fetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const result = await dispatchWebhook(subscription, match);

      expect(result).toEqual({ success: true, status: 200 });
      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com/hook',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      // Check payload
      const callArgs = global.fetch.mock.calls[0][1];
      const payload = JSON.parse(callArgs.body);
      expect(payload).toEqual({
        subscriptionId: 'sub-1',
        matchType: 'vector',
        chunkId: 'chunk-1',
        similarity: 0.92,
        content_preview: 'Some content preview',
        title: null,
        subtitle: null,
      });
    });

    it('returns failure on non-ok response', async () => {
      global.fetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await dispatchWebhook(subscription, match);

      expect(result).toEqual({ success: false, status: 500 });
    });

    it('returns failure on timeout (AbortError)', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      global.fetch.mockRejectedValueOnce(abortError);

      const result = await dispatchWebhook(subscription, match);

      expect(result).toEqual({ success: false, error: 'timeout' });
    });

    it('returns failure on network error', async () => {
      global.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await dispatchWebhook(subscription, match);

      expect(result).toEqual({ success: false, error: 'ECONNREFUSED' });
    });

    it('returns failure when no webhook_url configured', async () => {
      const noUrlSub = { ...subscription, webhook_url: null };

      const result = await dispatchWebhook(noUrlSub, match);

      expect(result).toEqual({ success: false, error: 'No webhook URL configured' });
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // --- dispatchNotification ---

  describe('dispatchNotification', () => {
    it('dispatches webhook for webhook subscriptions', async () => {
      global.fetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const sub = { id: 'sub-1', notification_method: 'webhook', webhook_url: 'https://example.com/hook' };
      const match = { chunkId: 'chunk-1', matchType: 'keyword' };

      // Should not throw
      await dispatchNotification(sub, match);

      expect(global.fetch).toHaveBeenCalled();
    });

    it('does not throw on webhook failure', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Network down'));

      const sub = { id: 'sub-1', notification_method: 'webhook', webhook_url: 'https://example.com/hook' };
      const match = { chunkId: 'chunk-1', matchType: 'keyword' };

      // Should not throw
      await expect(dispatchNotification(sub, match)).resolves.toBeUndefined();
    });

    it('handles a2a as stub without throwing', async () => {
      const sub = { id: 'sub-1', notification_method: 'a2a' };
      const match = { chunkId: 'chunk-1', matchType: 'topic' };

      await expect(dispatchNotification(sub, match)).resolves.toBeUndefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('handles polling method (no-op)', async () => {
      const sub = { id: 'sub-1', notification_method: 'polling' };
      const match = { chunkId: 'chunk-1', matchType: 'topic' };

      await expect(dispatchNotification(sub, match)).resolves.toBeUndefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // --- getPendingNotifications ---

  describe('getPendingNotifications', () => {
    it('returns empty when no polling subscriptions exist', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await getPendingNotifications(ACCOUNT_ID, {});

      expect(result.data).toEqual([]);
      expect(result.pagination.total).toBe(0);
    });

    it('returns matching chunks for topic polling subscription', async () => {
      // Polling subscriptions
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'sub-1', type: 'topic', topic_id: 'topic-1', keyword: null, embedding: null, similarity_threshold: null, lang: null }],
      });
      // Batched topic chunks query — now includes topic_id in result
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { chunk_id: 'chunk-1', content: 'New content about AI', created_at: new Date().toISOString(), topic_id: 'topic-1' },
        ],
      });

      const result = await getPendingNotifications(ACCOUNT_ID, {});

      expect(result.data).toHaveLength(1);
      expect(result.data[0].subscriptionId).toBe('sub-1');
      expect(result.data[0].matchType).toBe('topic');
      expect(result.data[0].chunkId).toBe('chunk-1');
    });

    it('returns matching chunks for keyword polling subscription', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'sub-2', type: 'keyword', topic_id: null, keyword: 'machine learning', embedding: null, similarity_threshold: null, lang: null }],
      });
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { chunk_id: 'chunk-2', content: 'Machine learning advances in 2026', created_at: new Date().toISOString() },
        ],
      });

      const result = await getPendingNotifications(ACCOUNT_ID, {});

      expect(result.data).toHaveLength(1);
      expect(result.data[0].matchType).toBe('keyword');
    });

    it('returns matching chunks for vector polling subscription', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'sub-3', type: 'vector', topic_id: null, keyword: null, embedding: '[0.1,0.2]', similarity_threshold: 0.85, lang: null }],
      });
      // Batched vector query returns match_info JSON object
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { chunk_id: 'chunk-3', content: 'Vector-matched content', created_at: new Date().toISOString(), match_info: { subId: 'sub-3', similarity: 0.91 } },
        ],
      });

      const result = await getPendingNotifications(ACCOUNT_ID, {});

      expect(result.data).toHaveLength(1);
      expect(result.data[0].matchType).toBe('vector');
      expect(result.data[0].similarity).toBe(0.91);
    });

    it('respects the since parameter', async () => {
      const since = '2026-03-17T00:00:00Z';
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'sub-1', type: 'keyword', topic_id: null, keyword: 'test', embedding: null, similarity_threshold: null, lang: null }],
      });
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await getPendingNotifications(ACCOUNT_ID, { since });

      const keywordQuery = mockPool.query.mock.calls[1];
      expect(keywordQuery[1][1]).toBe(since);
    });
  });
});
