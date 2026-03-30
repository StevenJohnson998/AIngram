/**
 * MCP server unit tests — verify tool registration and auth gating.
 * Service-level behavior is tested via integration tests in tests/integration/.
 */

const { createMcpServer } = require('../server');

const MOCK_ACCOUNT = {
  id: 'acc-123',
  name: 'test-agent',
  type: 'ai',
  status: 'active',
  tier: 1,
  badgeContribution: true,
  badgePolicing: false,
  badgeElite: false,
};

const SESSION_ID = 'test-session-123';
const AUTH_SESSION = (sessionId) => sessionId === SESSION_ID ? MOCK_ACCOUNT : null;
const NO_AUTH_SESSION = () => null;

describe('MCP Server', () => {
  describe('tool registration', () => {
    it('registers all 12 tools', () => {
      const server = createMcpServer(AUTH_SESSION);
      const names = Object.keys(server._registeredTools);
      expect(names).toHaveLength(12);
      expect(names).toEqual(expect.arrayContaining([
        'search', 'get_topic', 'get_chunk', 'list_review_queue',
        'contribute_chunk', 'propose_edit', 'commit_vote', 'reveal_vote',
        'object_chunk', 'subscribe', 'my_reputation', 'suggest_improvement',
      ]));
    });

    it('all tools have descriptions and handlers', () => {
      const server = createMcpServer(AUTH_SESSION);
      for (const [name, tool] of Object.entries(server._registeredTools)) {
        expect(tool.description).toBeTruthy();
        expect(typeof tool.handler).toBe('function');
      }
    });
  });

  describe('auth gating on write tools', () => {
    let server;

    beforeAll(() => {
      server = createMcpServer(NO_AUTH_SESSION);
    });

    const writeTools = [
      ['contribute_chunk', { topicId: 't1', content: 'test content here' }],
      ['propose_edit', { chunkId: 'c1', content: 'new content here' }],
      ['commit_vote', { chunkId: 'c1', commitHash: 'a'.repeat(64) }],
      ['reveal_vote', { chunkId: 'c1', voteValue: 1, reasonTag: 'accurate', salt: 'abc' }],
      ['object_chunk', { chunkId: 'c1' }],
      ['subscribe', { type: 'topic', topicId: 't1' }],
      ['suggest_improvement', { topicId: 't1', content: 'a'.repeat(25), suggestionCategory: 'governance', title: 'Test' }],
    ];

    it.each(writeTools)('%s returns UNAUTHORIZED error without auth', async (toolName, args) => {
      const tool = server._registeredTools[toolName];
      const result = await tool.handler(args, { sessionId: 'unknown-session' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.code).toBe('UNAUTHORIZED');
    });

    it('my_reputation returns UNAUTHORIZED error without auth', async () => {
      const tool = server._registeredTools['my_reputation'];
      // my_reputation has empty inputSchema, so SDK calls handler(args, extra)
      const result = await tool.handler({}, { sessionId: 'unknown-session' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.code).toBe('UNAUTHORIZED');
    });
  });

  describe('read tools do not require auth', () => {
    let server;

    beforeAll(() => {
      server = createMcpServer(NO_AUTH_SESSION);
    });

    it('search does not check auth', async () => {
      const tool = server._registeredTools['search'];
      // Will hit real DB or fail on DB, but should NOT return UNAUTHORIZED
      const result = await tool.handler({ query: 'test' }, { sessionId: 'anon' });
      if (result.isError) {
        const data = JSON.parse(result.content[0].text);
        expect(data.code).not.toBe('UNAUTHORIZED');
      }
    });

    it('list_review_queue does not check auth', async () => {
      const tool = server._registeredTools['list_review_queue'];
      const result = await tool.handler({}, { sessionId: 'anon' });
      if (result.isError) {
        const data = JSON.parse(result.content[0].text);
        expect(data.code).not.toBe('UNAUTHORIZED');
      }
    });
  });
});
