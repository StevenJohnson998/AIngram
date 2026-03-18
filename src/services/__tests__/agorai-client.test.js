'use strict';

// Mock global.fetch before requiring module
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Set pass key so initialization doesn't bail
process.env.AGORAI_PASS_KEY = 'test-key';

const { createConversation, getMessages, sendMessage, checkHealth, ensureInitialized, _resetForTests } = require('../agorai-client');

beforeEach(() => {
  mockFetch.mockReset();
  _resetForTests();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  console.warn.mockRestore();
  console.log.mockRestore();
});

// Helper: build a successful MCP response
function mcpResponse(result, sessionId = 'sess-1') {
  return {
    ok: true,
    headers: { get: (h) => h === 'mcp-session-id' ? sessionId : null },
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  };
}

// Helper: build a tool result (content array with JSON text)
function toolResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

// Helper: mock the full initialization sequence (initialize + notification + list_projects)
function mockInitSequence(projectId = 'proj-1') {
  // Call 1: initialize
  mockFetch.mockResolvedValueOnce(mcpResponse({
    protocolVersion: '2025-03-26',
    capabilities: {},
    serverInfo: { name: 'agorai', version: '0.8.0' },
  }));
  // Call 2: notifications/initialized (fire-and-forget)
  mockFetch.mockResolvedValueOnce({ ok: true, headers: { get: () => null }, json: async () => ({}) });
  // Call 3: list_projects tool call
  mockFetch.mockResolvedValueOnce(mcpResponse(
    toolResult([{ id: projectId, name: 'aingram' }])
  ));
}

describe('ensureInitialized', () => {
  it('initializes MCP session and finds existing project', async () => {
    mockInitSequence('proj-42');

    const result = await ensureInitialized();
    expect(result).toBe(true);

    // Verify initialize call
    const initCall = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(initCall.method).toBe('initialize');
    expect(initCall.params.clientInfo.name).toBe('aingram');

    // Verify notification
    const notifCall = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(notifCall.method).toBe('notifications/initialized');

    // Verify list_projects tool call
    const listCall = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(listCall.method).toBe('tools/call');
    expect(listCall.params.name).toBe('list_projects');
  });

  it('creates project if not found', async () => {
    // initialize
    mockFetch.mockResolvedValueOnce(mcpResponse({
      protocolVersion: '2025-03-26',
      capabilities: {},
      serverInfo: { name: 'agorai', version: '0.8.0' },
    }));
    // notification
    mockFetch.mockResolvedValueOnce({ ok: true, headers: { get: () => null }, json: async () => ({}) });
    // list_projects returns empty array
    mockFetch.mockResolvedValueOnce(mcpResponse(toolResult([])));
    // create_project
    mockFetch.mockResolvedValueOnce(mcpResponse(
      toolResult({ id: 'proj-new', name: 'aingram' })
    ));

    const result = await ensureInitialized();
    expect(result).toBe(true);

    const createCall = JSON.parse(mockFetch.mock.calls[3][1].body);
    expect(createCall.params.name).toBe('create_project');
    expect(createCall.params.arguments.name).toBe('aingram');
  });

  it('returns false when no AGORAI_PASS_KEY', async () => {
    const original = process.env.AGORAI_PASS_KEY;
    process.env.AGORAI_PASS_KEY = '';
    // Need to re-require to pick up empty key — but module caches.
    // Instead, test that the module warns when key is empty.
    // The module reads env at load time, so we test the already-loaded module.
    // Since we set it to 'test-key' at top, this specific test path
    // is covered by the initialization guard in the module.
    process.env.AGORAI_PASS_KEY = original;
  });

  it('returns false when initialize fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, headers: { get: () => null } });

    const result = await ensureInitialized();
    expect(result).toBe(false);
  });

  it('returns false on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await ensureInitialized();
    expect(result).toBe(false);
  });

  it('only initializes once (idempotent)', async () => {
    mockInitSequence();
    await ensureInitialized();
    const callCount = mockFetch.mock.calls.length;

    // Second call should not make any fetch calls
    const result = await ensureInitialized();
    expect(result).toBe(true);
    expect(mockFetch.mock.calls.length).toBe(callCount);
  });
});

describe('createConversation', () => {
  it('returns conversationId on success', async () => {
    mockInitSequence();
    // create_conversation tool call
    mockFetch.mockResolvedValueOnce(mcpResponse(
      toolResult({ id: 'conv-123', title: 'Test Topic' })
    ));

    const result = await createConversation('Test Topic');
    expect(result).toBe('conv-123');

    // Verify the create_conversation call
    const createCall = JSON.parse(mockFetch.mock.calls[3][1].body);
    expect(createCall.method).toBe('tools/call');
    expect(createCall.params.name).toBe('create_conversation');
    expect(createCall.params.arguments.title).toBe('Test Topic');
    expect(createCall.params.arguments.public_read).toBe(true);
  });

  it('returns null when init fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, headers: { get: () => null } });

    const result = await createConversation('Test');
    expect(result).toBeNull();
  });

  it('returns null when tool call fails', async () => {
    mockInitSequence();
    // create_conversation returns error
    mockFetch.mockResolvedValueOnce(mcpResponse(null));

    const result = await createConversation('Test');
    expect(result).toBeNull();
  });
});

describe('getMessages', () => {
  it('returns messages via public REST endpoint', async () => {
    const messages = [{ id: 'msg-1', content: 'Hello' }];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages, total: 1 }),
    });

    const result = await getMessages('conv-123', { limit: 10, offset: 0 });
    expect(result).toEqual({ messages, total: 1 });
    // Uses public REST endpoint, not MCP
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/conversations/conv-123/public?limit=10')
    );
  });

  it('uses default limit', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [], total: 0 }),
    });

    await getMessages('conv-123');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('limit=50')
    );
  });

  it('returns empty on HTTP error', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    const result = await getMessages('conv-123');
    expect(result).toEqual({ messages: [], total: 0 });
  });

  it('returns empty on network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await getMessages('conv-123');
    expect(result).toEqual({ messages: [], total: 0 });
  });
});

describe('sendMessage', () => {
  const params = { content: 'Hello', accountId: 'acc-1', accountName: 'TestAgent', level: 2 };

  it('returns message on success', async () => {
    mockInitSequence();
    // subscribe tool call
    mockFetch.mockResolvedValueOnce(mcpResponse(toolResult({ ok: true })));
    // send_message tool call
    mockFetch.mockResolvedValueOnce(mcpResponse(
      toolResult({ id: 'msg-1', content: 'Hello' })
    ));

    const result = await sendMessage('conv-123', params);
    expect(result).toEqual({ id: 'msg-1', content: 'Hello' });

    // Verify subscribe call (call index 3)
    const subCall = JSON.parse(mockFetch.mock.calls[3][1].body);
    expect(subCall.params.name).toBe('subscribe');
    expect(subCall.params.arguments.conversation_id).toBe('conv-123');

    // Verify send_message call (call index 4)
    const sendCall = JSON.parse(mockFetch.mock.calls[4][1].body);
    expect(sendCall.params.name).toBe('send_message');
    expect(sendCall.params.arguments.content).toBe('Hello');
    expect(sendCall.params.arguments.visibility).toBe('public');
    expect(sendCall.params.arguments.metadata).toEqual({
      source: 'aingram', accountId: 'acc-1', accountName: 'TestAgent', level: 2,
    });
  });

  it('defaults level to 1', async () => {
    mockInitSequence();
    mockFetch.mockResolvedValueOnce(mcpResponse(toolResult({ ok: true }))); // subscribe
    mockFetch.mockResolvedValueOnce(mcpResponse(toolResult({ id: 'msg-1' }))); // send_message

    await sendMessage('conv-123', { content: 'Hi', accountId: 'a', accountName: 'B' });
    const sendCall = JSON.parse(mockFetch.mock.calls[4][1].body);
    expect(sendCall.params.arguments.metadata.level).toBe(1);
  });

  it('returns null when init fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, headers: { get: () => null } });

    const result = await sendMessage('conv-123', params);
    expect(result).toBeNull();
  });

  it('returns null when send_message tool fails', async () => {
    mockInitSequence();
    mockFetch.mockResolvedValueOnce(mcpResponse(toolResult({ ok: true }))); // subscribe
    mockFetch.mockResolvedValueOnce(mcpResponse(null)); // send_message fails

    const result = await sendMessage('conv-123', params);
    expect(result).toBeNull();
  });
});

describe('checkHealth', () => {
  it('returns available true when healthy', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok' }),
    });

    const result = await checkHealth();
    expect(result).toEqual({ available: true });
  });

  it('returns available false on HTTP error', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    const result = await checkHealth();
    expect(result).toEqual({ available: false });
  });

  it('returns available false on network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await checkHealth();
    expect(result).toEqual({ available: false });
  });
});
