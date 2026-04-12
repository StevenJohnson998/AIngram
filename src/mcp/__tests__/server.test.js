/**
 * MCP server unit tests — verify tool registration, auth gating,
 * and progressive disclosure (meta-tools + enable/disable).
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

const CORE_TOOL_NAMES = [
  'search', 'get_topic', 'get_chunk', 'list_review_queue',
  'contribute_chunk', 'propose_edit', 'commit_vote', 'reveal_vote',
  'object_changeset', 'subscribe', 'poll_notifications', 'my_reputation',
  'get_changeset', 'cast_vote',
  'suggest_improvement', 'discover_related_topics', 'discover_related_chunks',
  'list_skills', 'get_skill',
];

const META_TOOL_NAMES = ['list_capabilities', 'enable_tools'];

describe('MCP Server', () => {
  describe('tool registration', () => {
    it('registers core tools + meta-tools + category tools', () => {
      const server = createMcpServer(AUTH_SESSION);
      const names = Object.keys(server._registeredTools);
      // Core (12) + meta (2) + account (14) + knowledge_curation (12) + governance (10) = 50
      expect(names.length).toBeGreaterThanOrEqual(14);
      expect(names).toEqual(expect.arrayContaining([...CORE_TOOL_NAMES, ...META_TOOL_NAMES]));
    });

    it('all registered tools have descriptions and handlers', () => {
      const server = createMcpServer(AUTH_SESSION);
      for (const [, tool] of Object.entries(server._registeredTools)) {
        expect(tool.description).toBeTruthy();
        expect(typeof tool.handler).toBe('function');
      }
    });

    it('core tools and meta-tools are enabled by default', () => {
      const server = createMcpServer(AUTH_SESSION);
      for (const name of [...CORE_TOOL_NAMES, ...META_TOOL_NAMES]) {
        expect(server._registeredTools[name].enabled).toBe(true);
      }
    });
  });

  describe('progressive disclosure', () => {
    it('list_capabilities returns all categories', async () => {
      const server = createMcpServer(AUTH_SESSION);
      const tool = server._registeredTools['list_capabilities'];
      const result = await tool.handler({}, {});
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data.categories).toBeInstanceOf(Array);
      expect(data.categories.length).toBeGreaterThanOrEqual(1);

      const core = data.categories.find(c => c.category === 'core');
      expect(core).toBeDefined();
      expect(core.enabled).toBe(true);
      expect(core.alwaysEnabled).toBe(true);
      expect(core.toolCount).toBe(CORE_TOOL_NAMES.length);
    });

    it('enable_tools rejects unknown category', async () => {
      const server = createMcpServer(AUTH_SESSION);
      const tool = server._registeredTools['enable_tools'];
      const result = await tool.handler({ category: 'nonexistent', enabled: true }, {});
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.code).toBe('VALIDATION_ERROR');
    });

    it('enable_tools cannot disable core', async () => {
      const server = createMcpServer(AUTH_SESSION);
      const tool = server._registeredTools['enable_tools'];
      const result = await tool.handler({ category: 'core', enabled: false }, {});
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data.enabled).toBe(true);
      expect(data.message).toContain('always enabled');
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
      ['commit_vote', { changesetId: 'c1', commitHash: 'a'.repeat(64) }],
      ['reveal_vote', { changesetId: 'c1', voteValue: 1, reasonTag: 'accurate', salt: 'abc' }],
      ['object_changeset', { changesetId: 'c1' }],
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
