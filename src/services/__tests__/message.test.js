jest.mock('../../config/database');
jest.mock('../injection-tracker', () => ({
  isBlocked: jest.fn().mockResolvedValue(false),
  recordDetection: jest.fn().mockResolvedValue({ blocked: false, score: 0, newlyBlocked: false }),
}));

const { getPool } = require('../../config/database');
const messageService = require('../message');

describe('message service', () => {
  let mockPool;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPool = {
      query: jest.fn(),
    };

    getPool.mockReturnValue(mockPool);
  });

  describe('TYPE_LEVEL_MAP', () => {
    it('maps level 1 types correctly', () => {
      expect(messageService.TYPE_LEVEL_MAP.contribution).toBe(1);
      expect(messageService.TYPE_LEVEL_MAP.reply).toBe(1);
      expect(messageService.TYPE_LEVEL_MAP.edit).toBe(1);
    });

    it('maps level 2 types correctly', () => {
      expect(messageService.TYPE_LEVEL_MAP.flag).toBe(2);
      expect(messageService.TYPE_LEVEL_MAP.merge).toBe(2);
      expect(messageService.TYPE_LEVEL_MAP.revert).toBe(2);
      expect(messageService.TYPE_LEVEL_MAP.moderation_vote).toBe(2);
    });

    it('maps level 3 types correctly', () => {
      expect(messageService.TYPE_LEVEL_MAP.coordination).toBe(3);
      expect(messageService.TYPE_LEVEL_MAP.debug).toBe(3);
      expect(messageService.TYPE_LEVEL_MAP.protocol).toBe(3);
    });
  });

  describe('createMessage', () => {
    it('creates a contribution message with level 1', async () => {
      const msg = {
        id: 'msg-1',
        topic_id: 'topic-1',
        account_id: 'acc-1',
        content: 'Hello',
        level: 1,
        type: 'contribution',
        parent_id: null,
      };
      mockPool.query.mockResolvedValue({ rows: [msg] });

      const result = await messageService.createMessage({
        topicId: 'topic-1',
        accountId: 'acc-1',
        content: 'Hello',
        type: 'contribution',
      });

      expect(result).toEqual(msg);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO messages'),
        ['topic-1', 'acc-1', 'Hello', 1, 'contribution', null]
      );
    });

    it('creates a flag message with level 2', async () => {
      const msg = { id: 'msg-2', level: 2, type: 'flag' };
      mockPool.query.mockResolvedValue({ rows: [msg] });

      const result = await messageService.createMessage({
        topicId: 'topic-1',
        accountId: 'acc-1',
        content: 'Flagged',
        type: 'flag',
      });

      expect(result.level).toBe(2);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO messages'),
        expect.arrayContaining([2, 'flag'])
      );
    });

    it('creates a coordination message with level 3', async () => {
      const msg = { id: 'msg-3', level: 3, type: 'coordination' };
      mockPool.query.mockResolvedValue({ rows: [msg] });

      const result = await messageService.createMessage({
        topicId: 'topic-1',
        accountId: 'acc-1',
        content: 'Sync',
        type: 'coordination',
      });

      expect(result.level).toBe(3);
    });

    it('creates each type with the correct level', async () => {
      for (const [type, level] of Object.entries(messageService.TYPE_LEVEL_MAP)) {
        mockPool.query.mockResolvedValue({ rows: [{ id: `msg-${type}`, level, type }] });

        const result = await messageService.createMessage({
          topicId: 'topic-1',
          accountId: 'acc-1',
          content: `Testing ${type}`,
          type,
        });

        expect(result.level).toBe(level);
      }
    });

    it('rejects invalid type', async () => {
      await expect(
        messageService.createMessage({
          topicId: 'topic-1',
          accountId: 'acc-1',
          content: 'Bad',
          type: 'invalid_type',
        })
      ).rejects.toThrow('Invalid message type: invalid_type');
    });

    it('verifies parent exists when parentId provided', async () => {
      // Parent lookup returns empty
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        messageService.createMessage({
          topicId: 'topic-1',
          accountId: 'acc-1',
          content: 'Reply',
          type: 'reply',
          parentId: 'nonexistent-parent',
        })
      ).rejects.toThrow('Parent message not found');
    });

    it('creates message with valid parentId', async () => {
      const parent = { id: 'parent-1' };
      const msg = { id: 'msg-reply', parent_id: 'parent-1', type: 'reply', level: 1 };

      mockPool.query
        .mockResolvedValueOnce({ rows: [parent] }) // parent lookup
        .mockResolvedValueOnce({ rows: [msg] }); // insert

      const result = await messageService.createMessage({
        topicId: 'topic-1',
        accountId: 'acc-1',
        content: 'Reply',
        type: 'reply',
        parentId: 'parent-1',
      });

      expect(result.parent_id).toBe('parent-1');
    });
  });

  describe('getMessageById', () => {
    it('returns message when found', async () => {
      const msg = { id: 'msg-1', content: 'Hello' };
      mockPool.query.mockResolvedValue({ rows: [msg] });

      const result = await messageService.getMessageById('msg-1');
      expect(result).toEqual(msg);
    });

    it('returns null when not found', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await messageService.getMessageById('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('listMessages', () => {
    it('returns paginated results with default verbosity (high = all levels)', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 30 }] })
        .mockResolvedValueOnce({ rows: [{ id: '1' }, { id: '2' }] });

      const result = await messageService.listMessages('topic-1', { page: 1, limit: 20 });

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 30 });

      // Should filter by levels [1,2,3]
      const countParams = mockPool.query.mock.calls[0][1];
      expect(countParams).toEqual(['topic-1', [1, 2, 3]]);
    });

    it('verbosity low returns only level 1', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 10 }] })
        .mockResolvedValueOnce({ rows: [] });

      await messageService.listMessages('topic-1', { verbosity: 'low', page: 1, limit: 20 });

      const countParams = mockPool.query.mock.calls[0][1];
      expect(countParams[1]).toEqual([1]);
    });

    it('verbosity medium returns levels 1 and 2', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 20 }] })
        .mockResolvedValueOnce({ rows: [] });

      await messageService.listMessages('topic-1', { verbosity: 'medium', page: 1, limit: 20 });

      const countParams = mockPool.query.mock.calls[0][1];
      expect(countParams[1]).toEqual([1, 2]);
    });

    it('applies reputation filter with JOIN', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 5 }] })
        .mockResolvedValueOnce({ rows: [] });

      await messageService.listMessages('topic-1', { minReputation: 10, page: 1, limit: 20 });

      // Count query should include accounts join and reputation param
      const countQuery = mockPool.query.mock.calls[0][0];
      const countParams = mockPool.query.mock.calls[0][1];
      expect(countQuery).toContain('JOIN accounts');
      expect(countQuery).toContain('reputation_contribution');
      expect(countParams).toEqual(['topic-1', [1, 2, 3], 10]);
    });

    it('handles pagination offset correctly', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 50 }] })
        .mockResolvedValueOnce({ rows: [{ id: '21' }] });

      const result = await messageService.listMessages('topic-1', { page: 2, limit: 20 });

      // Data query params: topicId, levels, limit, offset
      const dataParams = mockPool.query.mock.calls[1][1];
      expect(dataParams).toEqual(['topic-1', [1, 2, 3], 20, 20]); // offset = (2-1)*20 = 20
      expect(result.pagination.page).toBe(2);
    });
  });

  describe('editMessage', () => {
    it('updates content and sets edited_at', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'msg-1', account_id: 'acc-1', status: 'active', created_at: new Date() }] }) // ownership + status + window check
        .mockResolvedValueOnce({ rows: [{ id: 'msg-1', content: 'Updated', edited_at: '2026-01-01' }] });

      const result = await messageService.editMessage('msg-1', 'acc-1', 'Updated');

      expect(result.content).toBe('Updated');
      expect(result.edited_at).toBeTruthy();
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE messages'),
        ['Updated', 'msg-1']
      );
    });

    it('rejects when message not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        messageService.editMessage('nonexistent', 'acc-1', 'Content')
      ).rejects.toThrow('Message not found');
    });

    it('rejects when caller is not the owner', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'msg-1', account_id: 'acc-other', status: 'active', created_at: new Date() }],
      });

      await expect(
        messageService.editMessage('msg-1', 'acc-1', 'Content')
      ).rejects.toThrow('Only the message author can edit');
    });

    it('rejected edit throws error with FORBIDDEN code', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'msg-1', account_id: 'acc-other', status: 'active', created_at: new Date() }],
      });

      try {
        await messageService.editMessage('msg-1', 'acc-1', 'Content');
      } catch (err) {
        expect(err.code).toBe('FORBIDDEN');
      }
    });
  });

  describe('getReplies', () => {
    it('returns paginated replies for a message', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 3 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] });

      const result = await messageService.getReplies('msg-1', { page: 1, limit: 20 });

      expect(result.data).toHaveLength(3);
      expect(result.pagination.total).toBe(3);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('parent_id'),
        ['msg-1']
      );
    });

    it('handles empty replies', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 0 }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await messageService.getReplies('msg-1');
      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
    });
  });

  describe('getMessagesByAccount', () => {
    it('returns paginated messages for an account', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ total: 15 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'm1' }, { id: 'm2' }] });

      const result = await messageService.getMessagesByAccount('acc-1', { page: 1, limit: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({ page: 1, limit: 2, total: 15 });
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('account_id'),
        ['acc-1']
      );
    });
  });
});
