'use strict';

jest.mock('../agorai-client');
jest.mock('../../config/database');

const agoraiClient = require('../agorai-client');
const { getPool } = require('../../config/database');
const { linkTopicToConversation, getDiscussion, postToDiscussion } = require('../topic-agorai');

const mockQuery = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  getPool.mockReturnValue({ query: mockQuery });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  console.warn.mockRestore();
});

describe('linkTopicToConversation', () => {
  it('creates conversation and updates topic', async () => {
    agoraiClient.createConversation.mockResolvedValue('conv-abc');
    mockQuery.mockResolvedValue({ rowCount: 1 });

    const result = await linkTopicToConversation('topic-1', 'My Topic');

    expect(agoraiClient.createConversation).toHaveBeenCalledWith('My Topic');
    expect(mockQuery).toHaveBeenCalledWith(
      'UPDATE topics SET agorai_conversation_id = $1 WHERE id = $2',
      ['conv-abc', 'topic-1']
    );
    expect(result).toEqual({ conversationId: 'conv-abc' });
  });

  it('returns null when Agorai is down', async () => {
    agoraiClient.createConversation.mockResolvedValue(null);

    const result = await linkTopicToConversation('topic-1', 'My Topic');

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns null on DB error', async () => {
    agoraiClient.createConversation.mockResolvedValue('conv-abc');
    mockQuery.mockRejectedValue(new Error('DB down'));

    const result = await linkTopicToConversation('topic-1', 'My Topic');

    expect(result).toBeNull();
  });
});

describe('getDiscussion', () => {
  it('fetches messages for linked topic', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ agorai_conversation_id: 'conv-abc', title: 'Topic' }],
    });
    const messages = [{ id: 'msg-1', content: 'Hi' }];
    agoraiClient.getMessages.mockResolvedValue({ messages, total: 1 });

    const result = await getDiscussion('topic-1', { limit: 10, offset: 0 });

    expect(result).toEqual({ messages, total: 1, available: true });
    expect(agoraiClient.getMessages).toHaveBeenCalledWith('conv-abc', { limit: 10, offset: 0 });
  });

  it('returns empty with available=true when no conversation linked', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ agorai_conversation_id: null, title: 'Topic' }],
    });

    const result = await getDiscussion('topic-1');

    expect(result).toEqual({ messages: [], total: 0, available: true });
    expect(agoraiClient.getMessages).not.toHaveBeenCalled();
  });

  it('returns unavailable when topic not found', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getDiscussion('nonexistent');

    expect(result).toEqual({ messages: [], total: 0, available: false });
  });

  it('returns unavailable on DB error', async () => {
    mockQuery.mockRejectedValue(new Error('DB down'));

    const result = await getDiscussion('topic-1');

    expect(result).toEqual({ messages: [], total: 0, available: false });
  });
});

describe('postToDiscussion', () => {
  const params = { content: 'Hello', accountId: 'acc-1', accountName: 'TestAgent', level: 2 };

  it('posts to existing conversation', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ agorai_conversation_id: 'conv-abc', title: 'Topic' }],
    });
    const msg = { id: 'msg-1', content: 'Hello' };
    agoraiClient.sendMessage.mockResolvedValue(msg);

    const result = await postToDiscussion('topic-1', params);

    expect(result).toEqual(msg);
    expect(agoraiClient.createConversation).not.toHaveBeenCalled();
    expect(agoraiClient.sendMessage).toHaveBeenCalledWith('conv-abc', params);
  });

  it('auto-creates conversation if none linked', async () => {
    // First query: topic lookup (no conversation)
    mockQuery.mockResolvedValueOnce({
      rows: [{ agorai_conversation_id: null, title: 'My Topic' }],
    });
    // Second query: UPDATE from linkTopicToConversation
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    agoraiClient.createConversation.mockResolvedValue('conv-new');
    const msg = { id: 'msg-1', content: 'Hello' };
    agoraiClient.sendMessage.mockResolvedValue(msg);

    const result = await postToDiscussion('topic-1', params);

    expect(agoraiClient.createConversation).toHaveBeenCalledWith('My Topic');
    expect(agoraiClient.sendMessage).toHaveBeenCalledWith('conv-new', params);
    expect(result).toEqual(msg);
  });

  it('returns null when topic not found', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await postToDiscussion('nonexistent', params);

    expect(result).toBeNull();
  });

  it('returns null when Agorai is down and no conversation exists', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ agorai_conversation_id: null, title: 'Topic' }],
    });
    agoraiClient.createConversation.mockResolvedValue(null);

    const result = await postToDiscussion('topic-1', params);

    expect(result).toBeNull();
  });

  it('returns null on DB error', async () => {
    mockQuery.mockRejectedValue(new Error('DB down'));

    const result = await postToDiscussion('topic-1', params);

    expect(result).toBeNull();
  });
});
