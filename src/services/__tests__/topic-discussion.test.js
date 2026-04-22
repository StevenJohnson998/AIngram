'use strict';

// Mock dependencies before requiring the module under test
jest.mock('../../config/database', () => {
  const mockQuery = jest.fn();
  return { getPool: () => ({ query: mockQuery }), _mockQuery: mockQuery };
});

jest.mock('../message', () => ({
  createMessage: jest.fn(),
  TYPE_LEVEL_MAP: { contribution: 1, reply: 1 },
  VALID_TYPES: ['contribution', 'reply'],
}));

const topicDiscussion = require('../topic-discussion');
const { _mockQuery: mockQuery } = require('../../config/database');
const messageService = require('../message');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getDiscussion', () => {
  it('returns unavailable when topic does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await topicDiscussion.getDiscussion('no-topic');
    expect(result).toEqual({ messages: [], total: 0, available: false });
  });

  it('returns messages with account info', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 't1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'm1', content: 'hello', level: 1, type: 'contribution',
        created_at: '2026-04-20T10:00:00Z', edited_at: null, parent_id: null,
        account_id: 'a1', account_name: 'Agent1', account_type: 'ai',
        primary_archetype: 'contributor',
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await topicDiscussion.getDiscussion('t1', { limit: 10, offset: 0 });
    expect(result.available).toBe(true);
    expect(result.total).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].account_name).toBe('Agent1');
    expect(result.messages[0].votes_up).toBe(0);
    expect(result.messages[0].votes_down).toBe(0);
    expect(result.discussionSummary).toBeNull();
  });

  it('includes discussion summary when available', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 't1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ discussion_summary: 'Summary text' }] });

    const result = await topicDiscussion.getDiscussion('t1');
    expect(result.discussionSummary).toBe('Summary text');
  });
});

describe('postToDiscussion', () => {
  it('delegates to messageService.createMessage', async () => {
    const fakeMessage = { id: 'm1', content: 'test', type: 'contribution', level: 1 };
    messageService.createMessage.mockResolvedValue(fakeMessage);

    const result = await topicDiscussion.postToDiscussion('t1', {
      content: 'test',
      accountId: 'a1',
    });

    expect(messageService.createMessage).toHaveBeenCalledWith({
      topicId: 't1',
      accountId: 'a1',
      content: 'test',
      type: 'contribution',
    });
    expect(result).toEqual(fakeMessage);
  });

  it('propagates DISCUSSION_BLOCKED errors', async () => {
    messageService.createMessage.mockRejectedValue(
      Object.assign(new Error('blocked'), { code: 'DISCUSSION_BLOCKED' })
    );

    await expect(
      topicDiscussion.postToDiscussion('t1', { content: 'x', accountId: 'a1' })
    ).rejects.toThrow('blocked');
  });
});
