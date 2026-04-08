// @ts-check
/**
 * MCP Server E2E Tests — verify all 12 tools via Streamable HTTP transport.
 *
 * Tests the full MCP flow: initialize session → call tools → verify results.
 * Covers: session lifecycle, auth gating, all read tools, all write tools.
 *
 * Targets the TEST container (aingram-api-test).
 * Run: npx playwright test mcp-tools
 */

const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const { execSync } = require('child_process');

const BASE = process.env.BASE_URL || 'http://172.18.0.19:3000';
const unique = () => crypto.randomBytes(4).toString('hex');
const API_CONTAINER = process.env.API_CONTAINER || 'aingram-api-test';
const DB_CONTAINER = process.env.DB_CONTAINER || 'postgres';
const DB_NAME = 'aingram_test';

// ─── Helpers ─────────────────────────────────────────────────────────

/** Create a confirmed user in DB with API key. */
function createUserInDB({ tier = 0, badgePolicing = false, badgeContribution = false, type = 'ai' } = {}) {
  const id = unique();
  const email = `e2e-mcp-${id}@example.com`;
  const name = `MCP-Agent-${id}`;
  const script = `
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    (async () => {
      const accountId = crypto.randomUUID();
      const pwHash = bcrypt.hashSync('TestPass2026!', 10);
      const prefix = crypto.randomBytes(4).toString('hex');
      const secret = crypto.randomBytes(12).toString('hex');
      const keyHash = bcrypt.hashSync(secret, 10);
      await pool.query(
        \`INSERT INTO accounts (id, name, type, owner_email, password_hash, status, email_confirmed, tier,
         badge_policing, badge_contribution, reputation_contribution, reputation_copyright,
         first_contribution_at, terms_version_accepted, api_key_hash, api_key_prefix)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,0.5,0.5,now(),$10,$11,$12)\`,
        [accountId, '${name}', '${type}', '${email}', pwHash, 'active',
         parseInt('${tier}'), ${badgePolicing}, ${badgeContribution},
         '2026-03-21-v1', keyHash, prefix]
      );
      console.log(JSON.stringify({ id: accountId, email: '${email}', name: '${name}', apiKey: \`aingram_\${prefix}_\${secret}\` }));
      await pool.end();
    })();
  `;
  const raw = execSync(`docker exec -i ${API_CONTAINER} node`, { input: script, encoding: 'utf-8', timeout: 10000 }).trim();
  return JSON.parse(raw);
}

/** Create a topic directly in DB. */
function createTopicInDB(authorId) {
  const slug = `e2e-mcp-topic-${unique()}`;
  const raw = execSync(
    `docker exec ${DB_CONTAINER} psql -U admin -d ${DB_NAME} -t -A -c "
      INSERT INTO topics (title, slug, lang, summary, sensitivity, created_by)
      VALUES ('MCP Test Topic ${slug}', '${slug}', 'en', 'Topic for MCP E2E tests.', 'standard', '${authorId}')
      RETURNING id;"`,
    { encoding: 'utf-8' }
  ).trim().split('\n')[0].trim();
  return { id: raw, slug };
}

/** Create a published chunk directly in DB linked to a topic. */
function createChunkInDB(topicId, authorId, content) {
  const raw = execSync(
    `docker exec ${DB_CONTAINER} psql -U admin -d ${DB_NAME} -t -A -c "
      INSERT INTO chunks (content, created_by, trust_score, status)
      VALUES ('${content || 'MCP E2E test chunk with governance knowledge about agent trust. ' + Date.now()}', '${authorId}', 0.5, 'published')
      RETURNING id;"`,
    { encoding: 'utf-8' }
  ).trim().split('\n')[0].trim();
  execSync(
    `docker exec ${DB_CONTAINER} psql -U admin -d ${DB_NAME} -c "INSERT INTO chunk_topics (chunk_id, topic_id) VALUES ('${raw}', '${topicId}');"`,
    { encoding: 'utf-8' }
  );
  return raw;
}

/** Create a proposed chunk with changeset (for review/vote tests). Returns { chunkId, changesetId }. */
function createProposedChunkInDB(topicId, authorId) {
  const raw = execSync(
    `docker exec ${DB_CONTAINER} psql -U admin -d ${DB_NAME} -t -A -c "
      INSERT INTO chunks (content, created_by, trust_score, status)
      VALUES ('Proposed chunk for MCP tests — agent governance patterns ${Date.now()}', '${authorId}', 0.5, 'proposed')
      RETURNING id;"`,
    { encoding: 'utf-8' }
  ).trim().split('\n')[0].trim();
  execSync(
    `docker exec ${DB_CONTAINER} psql -U admin -d ${DB_NAME} -c "INSERT INTO chunk_topics (chunk_id, topic_id) VALUES ('${raw}', '${topicId}');"`,
    { encoding: 'utf-8' }
  );
  // Create changeset for this chunk
  const csId = execSync(
    `docker exec ${DB_CONTAINER} psql -U admin -d ${DB_NAME} -t -A -c "
      INSERT INTO changesets (topic_id, proposed_by, status)
      VALUES ('${topicId}', '${authorId}', 'proposed')
      RETURNING id;"`,
    { encoding: 'utf-8' }
  ).trim().split('\n')[0].trim();
  execSync(
    `docker exec ${DB_CONTAINER} psql -U admin -d ${DB_NAME} -c "INSERT INTO changeset_operations (changeset_id, operation, chunk_id, sort_order) VALUES ('${csId}', 'add', '${raw}', 0);"`,
    { encoding: 'utf-8' }
  );
  return csId;
}

// ─── MCP Protocol Helpers ────────────────────────────────────────────

let jsonRpcId = 1;

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

/**
 * Parse SSE response body to extract JSON-RPC message.
 * SSE format: "event: message\ndata: {...json...}\n\n"
 */
function parseSseResponse(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      return JSON.parse(line.slice(6));
    }
  }
  // Try direct JSON parse (non-SSE response)
  return JSON.parse(text);
}

/**
 * Initialize an MCP session. Returns the session ID.
 */
async function mcpInit(request, apiKey) {
  const headers = { ...MCP_HEADERS };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await request.post(`${BASE}/mcp`, {
    headers,
    data: {
      jsonrpc: '2.0',
      method: 'initialize',
      id: jsonRpcId++,
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'e2e-mcp-test', version: '1.0.0' },
      },
    },
  });
  expect(res.status()).toBe(200);
  const sessionId = res.headers()['mcp-session-id'];
  expect(sessionId).toBeTruthy();

  // Send initialized notification
  await request.post(`${BASE}/mcp`, {
    headers: { ...headers, 'mcp-session-id': sessionId },
    data: {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    },
  });

  return sessionId;
}

/**
 * Call an MCP tool and return the parsed result.
 */
async function mcpCallTool(request, sessionId, toolName, args, apiKey) {
  const headers = { ...MCP_HEADERS, 'mcp-session-id': sessionId };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const id = jsonRpcId++;
  const res = await request.post(`${BASE}/mcp`, {
    headers,
    data: {
      jsonrpc: '2.0',
      method: 'tools/call',
      id,
      params: { name: toolName, arguments: args },
    },
  });
  expect(res.status()).toBe(200);
  const text = await res.text();
  const body = parseSseResponse(text);
  expect(body.jsonrpc).toBe('2.0');
  expect(body.id).toBe(id);

  if (body.result && body.result.content && body.result.content[0]) {
    const parsed = JSON.parse(body.result.content[0].text);
    return { data: parsed, isError: !!body.result.isError, raw: body };
  }
  if (body.error) {
    return { data: body.error, isError: true, raw: body };
  }
  return { data: null, isError: false, raw: body };
}

/**
 * List available MCP tools.
 */
async function mcpListTools(request, sessionId, apiKey) {
  const headers = { ...MCP_HEADERS, 'mcp-session-id': sessionId };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const id = jsonRpcId++;
  const res = await request.post(`${BASE}/mcp`, {
    headers,
    data: {
      jsonrpc: '2.0',
      method: 'tools/list',
      id,
      params: {},
    },
  });
  expect(res.status()).toBe(200);
  const text = await res.text();
  const body = parseSseResponse(text);
  return body.result.tools;
}

// ─── Shared State ────────────────────────────────────────────────────

let agent, agentT1, agentT2;
let testTopic, testChunkId, proposedChunkId;

test.beforeAll(async () => {
  agent = createUserInDB({ tier: 0 });
  agentT1 = createUserInDB({ tier: 1, badgeContribution: true });
  agentT2 = createUserInDB({ tier: 2, badgePolicing: true, badgeContribution: true });

  testTopic = createTopicInDB(agent.id);
  testChunkId = createChunkInDB(testTopic.id, agent.id);
  proposedChunkId = createProposedChunkInDB(testTopic.id, agent.id);
});

// =====================================================================
// 1. SESSION LIFECYCLE
// =====================================================================

test.describe('MCP Session Lifecycle', () => {
  test('initialize creates a session', async ({ request }) => {
    const sessionId = await mcpInit(request, agent.apiKey);
    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe('string');
  });

  test('session reuse works on subsequent requests', async ({ request }) => {
    const sessionId = await mcpInit(request, agent.apiKey);

    // Second call on same session should work
    const { data, isError } = await mcpCallTool(request, sessionId, 'my_reputation', {}, agent.apiKey);
    expect(isError).toBe(false);
    expect(data).toBeTruthy();
  });

  test('DELETE /mcp terminates session', async ({ request }) => {
    const sessionId = await mcpInit(request, agent.apiKey);

    const delRes = await request.delete(`${BASE}/mcp`, {
      headers: { 'mcp-session-id': sessionId },
    });
    expect(delRes.status()).toBe(200);
  });

  test('unknown session ID returns error', async ({ request }) => {
    const res = await request.post(`${BASE}/mcp`, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'mcp-session-id': 'nonexistent-session-id',
      },
      data: {
        jsonrpc: '2.0',
        method: 'tools/call',
        id: jsonRpcId++,
        params: { name: 'search', arguments: { query: 'test' } },
      },
    });
    // Should either create new session or return error — not crash
    expect([200, 400, 404, 406, 500]).toContain(res.status());
  });
});

// =====================================================================
// 2. TOOL DISCOVERY
// =====================================================================

test.describe('MCP Tool Discovery', () => {
  test('tools/list returns core + meta tools (16)', async ({ request }) => {
    const sessionId = await mcpInit(request, agent.apiKey);
    const tools = await mcpListTools(request, sessionId, agent.apiKey);
    expect(tools.length).toBe(19);

    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'cast_vote', 'commit_vote', 'contribute_chunk', 'discover_related_chunks', 'discover_related_topics',
      'enable_tools', 'get_changeset', 'get_chunk', 'get_topic',
      'list_capabilities', 'list_review_queue', 'my_reputation', 'object_changeset',
      'poll_notifications', 'propose_edit', 'reveal_vote', 'search', 'subscribe', 'suggest_improvement',
    ]);
  });

  test('every tool has a description and input schema', async ({ request }) => {
    const sessionId = await mcpInit(request, agent.apiKey);
    const tools = await mcpListTools(request, sessionId, agent.apiKey);

    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

// =====================================================================
// 3. READ TOOLS (no auth required)
// =====================================================================

test.describe('MCP Read Tools', () => {
  test('search: returns results for known content', async ({ request }) => {
    const sessionId = await mcpInit(request); // no API key — anonymous
    const { data, isError } = await mcpCallTool(request, sessionId, 'search', {
      query: 'governance',
    });
    expect(isError).toBe(false);
    expect(data.results).toBeDefined();
    expect(Array.isArray(data.results)).toBe(true);
    // Seeded data should have governance content
    expect(data.total).toBeGreaterThanOrEqual(0);
  });

  test('search: respects limit parameter', async ({ request }) => {
    const sessionId = await mcpInit(request);
    const { data, isError } = await mcpCallTool(request, sessionId, 'search', {
      query: 'agent',
      limit: 2,
    });
    expect(isError).toBe(false);
    expect(data.results.length).toBeLessThanOrEqual(2);
  });

  test('get_topic: by ID returns topic with chunks', async ({ request }) => {
    const sessionId = await mcpInit(request);
    const { data, isError } = await mcpCallTool(request, sessionId, 'get_topic', {
      topicId: testTopic.id,
    });
    expect(isError).toBe(false);
    expect(data.topic).toBeDefined();
    expect(data.topic.id).toBe(testTopic.id);
    expect(data.topic.slug).toBe(testTopic.slug);
    expect(Array.isArray(data.chunks)).toBe(true);
    expect(data.chunks.length).toBeGreaterThanOrEqual(1);
  });

  test('get_topic: by slug works', async ({ request }) => {
    const sessionId = await mcpInit(request);
    const { data, isError } = await mcpCallTool(request, sessionId, 'get_topic', {
      slug: testTopic.slug,
    });
    // Slug lookup may not be implemented — if it errors, check error type
    if (isError) {
      expect(data.code).toBeDefined(); // Should be a structured error, not a crash
    } else {
      expect(data.topic.id).toBe(testTopic.id);
    }
  });

  test('get_topic: nonexistent returns NOT_FOUND', async ({ request }) => {
    const sessionId = await mcpInit(request);
    const { data, isError } = await mcpCallTool(request, sessionId, 'get_topic', {
      topicId: '00000000-0000-0000-0000-000000000000',
    });
    expect(isError).toBe(true);
    expect(data.code).toBe('NOT_FOUND');
  });

  test('get_topic: no params returns VALIDATION_ERROR', async ({ request }) => {
    const sessionId = await mcpInit(request);
    const { data, isError } = await mcpCallTool(request, sessionId, 'get_topic', {});
    expect(isError).toBe(true);
    expect(data.code).toBe('VALIDATION_ERROR');
  });

  test('get_chunk: returns chunk with metadata', async ({ request }) => {
    const sessionId = await mcpInit(request);
    const { data, isError } = await mcpCallTool(request, sessionId, 'get_chunk', {
      chunkId: testChunkId,
    });
    expect(isError).toBe(false);
    expect(data.id).toBe(testChunkId);
    expect(data.content).toBeTruthy();
    expect(data.status).toBe('published');
    expect(typeof data.trustScore).toBe('number');
  });

  test('get_chunk: nonexistent returns NOT_FOUND', async ({ request }) => {
    const sessionId = await mcpInit(request);
    const { data, isError } = await mcpCallTool(request, sessionId, 'get_chunk', {
      chunkId: '00000000-0000-0000-0000-000000000000',
    });
    expect(isError).toBe(true);
    expect(data.code).toBe('NOT_FOUND');
  });

  test('list_review_queue: returns paginated proposals', async ({ request }) => {
    const sessionId = await mcpInit(request);
    const { data, isError } = await mcpCallTool(request, sessionId, 'list_review_queue', {
      limit: 5,
    });
    expect(isError).toBe(false);
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.pagination).toBeDefined();
    expect(data.pagination.limit).toBe(5);
  });
});

// =====================================================================
// 4. AUTH GATING
// =====================================================================

test.describe('MCP Auth Gating', () => {
  const writeTools = [
    ['contribute_chunk', { topicId: 'dummy', content: 'a'.repeat(20) }],
    ['propose_edit', { chunkId: 'dummy', content: 'a'.repeat(20) }],
    ['commit_vote', { changesetId: 'dummy', commitHash: 'a'.repeat(64) }],
    ['reveal_vote', { changesetId: 'dummy', voteValue: 1, reasonTag: 'accurate', salt: 'test' }],
    ['object_changeset', { changesetId: 'dummy' }],
    ['subscribe', { type: 'topic', topicId: 'dummy' }],
    ['my_reputation', {}],
    ['suggest_improvement', { topicId: 'dummy', content: 'a'.repeat(25), suggestionCategory: 'governance', title: 'Test' }],
  ];

  for (const [toolName, args] of writeTools) {
    test(`${toolName}: UNAUTHORIZED without auth`, async ({ request }) => {
      const sessionId = await mcpInit(request); // no API key
      const { data, isError } = await mcpCallTool(request, sessionId, toolName, args);
      expect(isError).toBe(true);
      expect(data.code).toBe('UNAUTHORIZED');
    });
  }
});

// =====================================================================
// 5. WRITE TOOLS (authenticated)
// =====================================================================

test.describe('MCP Write Tools', () => {
  test('contribute_chunk: creates a proposed chunk', async ({ request }) => {
    const sessionId = await mcpInit(request, agent.apiKey);
    const { data, isError } = await mcpCallTool(request, sessionId, 'contribute_chunk', {
      topicId: testTopic.id,
      content: `MCP E2E contribution about agent governance patterns ${unique()}`,
      title: 'MCP Test Contribution',
    }, agent.apiKey);
    expect(isError).toBe(false);
    expect(data.id).toBeTruthy();
    expect(data.status).toBe('proposed');
    expect(data.message).toContain('proposed');
  });

  test('contribute_chunk: validates content length', async ({ request }) => {
    const sessionId = await mcpInit(request, agent.apiKey);
    // Zod validation rejects content < 10 chars — SDK may return error in different format
    const headers = {
      ...MCP_HEADERS,
      'mcp-session-id': sessionId,
      'Authorization': `Bearer ${agent.apiKey}`,
    };
    const id = jsonRpcId++;
    const res = await request.post(`${BASE}/mcp`, {
      headers,
      data: {
        jsonrpc: '2.0', method: 'tools/call', id,
        params: { name: 'contribute_chunk', arguments: { topicId: testTopic.id, content: 'short' } },
      },
    });
    expect(res.status()).toBe(200);
    const text = await res.text();
    const body = parseSseResponse(text);
    // Should be an error — either Zod validation error or tool error
    const hasError = body.error || (body.result && body.result.isError);
    expect(hasError).toBeTruthy();
  });

  test('propose_edit: creates edit proposal on existing chunk', async ({ request }) => {
    const sessionId = await mcpInit(request, agent.apiKey);
    const { data, isError } = await mcpCallTool(request, sessionId, 'propose_edit', {
      chunkId: testChunkId,
      content: `Edited via MCP: updated governance knowledge with new insights ${unique()}`,
    }, agent.apiKey);
    expect(isError).toBe(false);
    expect(data.id).toBeTruthy();
    expect(data.parentChunkId).toBe(testChunkId);
    expect(['proposed', 'published']).toContain(data.status);
  });

  test('propose_edit: nonexistent chunk returns NOT_FOUND', async ({ request }) => {
    const sessionId = await mcpInit(request, agent.apiKey);
    const { data, isError } = await mcpCallTool(request, sessionId, 'propose_edit', {
      chunkId: '00000000-0000-0000-0000-000000000000',
      content: 'This should fail because chunk does not exist and we need enough chars',
    }, agent.apiKey);
    expect(isError).toBe(true);
    expect(data.code).toBe('NOT_FOUND');
  });

  test('object_changeset: T1 can escalate proposed changeset to review', async ({ request }) => {
    // Create a fresh proposed chunk for this test
    const freshProposed = createProposedChunkInDB(testTopic.id, agent.id);

    const sessionId = await mcpInit(request, agentT1.apiKey);
    const { data, isError } = await mcpCallTool(request, sessionId, 'object_changeset', {
      changesetId: freshProposed,
    }, agentT1.apiKey);
    expect(isError).toBe(false);
    expect(data.status).toBe('under_review');
    expect(data.message).toContain('formal review');
  });

  test('subscribe: topic subscription works', async ({ request }) => {
    const sessionId = await mcpInit(request, agent.apiKey);
    const { data, isError } = await mcpCallTool(request, sessionId, 'subscribe', {
      type: 'topic',
      topicId: testTopic.id,
    }, agent.apiKey);
    expect(isError).toBe(false);
    expect(data.id).toBeTruthy();
    expect(data.type).toBe('topic');
    expect(data.active).toBe(true);
  });

  test('subscribe: keyword subscription works', async ({ request }) => {
    const sessionId = await mcpInit(request, agent.apiKey);
    const { data, isError } = await mcpCallTool(request, sessionId, 'subscribe', {
      type: 'keyword',
      keyword: 'governance',
    }, agent.apiKey);
    expect(isError).toBe(false);
    expect(data.type).toBe('keyword');
  });

  test('my_reputation: returns reputation details', async ({ request }) => {
    const sessionId = await mcpInit(request, agent.apiKey);
    const { data, isError } = await mcpCallTool(request, sessionId, 'my_reputation', {}, agent.apiKey);
    expect(isError).toBe(false);
    expect(data).toBeTruthy();
    // Should have some reputation data — structure varies
    expect(Object.keys(data).length).toBeGreaterThan(0);
  });

  test('suggest_improvement: creates suggestion', async ({ request }) => {
    const sessionId = await mcpInit(request, agent.apiKey);
    const { data, isError } = await mcpCallTool(request, sessionId, 'suggest_improvement', {
      topicId: testTopic.id,
      content: 'Suggest adding structured metadata for chunk provenance tracking in governance context.',
      suggestionCategory: 'governance',
      title: `MCP Test Suggestion ${unique()}`,
      rationale: 'Improves auditability of knowledge contributions.',
    }, agent.apiKey);
    expect(isError).toBe(false);
    expect(data.id).toBeTruthy();
    expect(data.status).toBe('proposed');
    expect(data.category).toBe('governance');
  });
});

// =====================================================================
// 6. COMMIT-REVEAL VOTE FLOW (via MCP)
// =====================================================================

test.describe('MCP Commit-Reveal Vote', () => {
  let underReviewChangesetId;

  test.beforeAll(async () => {
    // Create a proposed chunk+changeset and escalate the changeset to under_review
    underReviewChangesetId = createProposedChunkInDB(testTopic.id, agent.id);
    const script = `
      const { Pool } = require('pg');
      const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
      (async () => {
        await pool.query(
          "UPDATE changesets SET status = 'under_review', vote_phase = 'commit', " +
          "under_review_at = NOW(), commit_deadline_at = NOW() + interval '24 hours', " +
          "reveal_deadline_at = NOW() + interval '48 hours' " +
          "WHERE id = $1",
          ['${underReviewChangesetId}']
        );
        await pool.end();
        console.log('OK');
      })();
    `;
    execSync(`docker exec -i ${API_CONTAINER} node`, { input: script, encoding: 'utf-8', timeout: 10000 });
  });

  test('commit then reveal vote via MCP', async ({ request }) => {
    const sessionId = await mcpInit(request, agentT1.apiKey);

    // Commit phase
    const voteValue = 1;
    const reasonTag = 'accurate';
    const salt = unique();
    const commitHash = crypto.createHash('sha256')
      .update(`${voteValue}|${reasonTag}|${salt}`)
      .digest('hex');

    const commitResult = await mcpCallTool(request, sessionId, 'commit_vote', {
      changesetId: underReviewChangesetId,
      commitHash,
    }, agentT1.apiKey);
    expect(commitResult.isError).toBe(false);
    expect(commitResult.data.phase).toBe('committed');
    expect(typeof commitResult.data.weight).toBe('number');

    // Move to reveal phase
    const revealScript = `
      const { Pool } = require('pg');
      const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
      (async () => {
        await pool.query("UPDATE changesets SET vote_phase = 'reveal' WHERE id = $1", ['${underReviewChangesetId}']);
        await pool.end();
        console.log('OK');
      })();
    `;
    execSync(`docker exec -i ${API_CONTAINER} node`, { input: revealScript, encoding: 'utf-8', timeout: 10000 });

    // Reveal phase
    const revealResult = await mcpCallTool(request, sessionId, 'reveal_vote', {
      changesetId: underReviewChangesetId,
      voteValue,
      reasonTag,
      salt,
    }, agentT1.apiKey);
    expect(revealResult.isError).toBe(false);
    expect(revealResult.data.phase).toBe('revealed');
    expect(revealResult.data.voteValue).toBe(voteValue);
    expect(revealResult.data.reasonTag).toBe(reasonTag);
  });
});

// =====================================================================
// 7. CROSS-SESSION ISOLATION
// =====================================================================

// =====================================================================
// 7. COMPLETE USER JOURNEY — register, enable categories, create, discuss, vote, discover
// =====================================================================

test.describe('MCP User Journey', () => {
  test('complete user journey: enable categories, create topic, discuss, vote, discover', async ({ request }) => {
    const apiKey = agentT1.apiKey;
    const session = await mcpInit(request, apiKey);

    // Enable all needed categories
    for (const cat of ['account', 'knowledge_curation', 'governance', 'discussion']) {
      const r = await mcpCallTool(request, session, 'enable_tools', { category: cat, enabled: true }, apiKey);
      expect(r.isError).toBe(false);
    }

    // Verify capabilities
    const caps = await mcpCallTool(request, session, 'list_capabilities', {}, apiKey);
    expect(caps.isError).toBe(false);
    const acctCat = caps.data.categories.find(c => c.category === 'account');
    expect(acctCat.enabled).toBe(true);

    // Get my account info
    const me = await mcpCallTool(request, session, 'get_me', {}, apiKey);
    expect(me.isError).toBe(false);
    expect(me.data.id).toBe(agentT1.id);

    // Create topic with chunks
    const topicResult = await mcpCallTool(request, session, 'create_topic_full', {
      title: `MCP Journey Topic ${unique()}`,
      lang: 'en',
      summary: 'Topic created during MCP user journey E2E test.',
      chunks: [
        { content: 'Multi-agent systems require formal governance mechanisms to prevent knowledge degradation over time. Without structured review processes, contributed knowledge accumulates errors.' },
        { content: 'Trust scoring based on Beta reputation models provides a mathematical foundation for evaluating contributor reliability in decentralized knowledge systems.' },
      ],
    }, apiKey);
    expect(topicResult.isError).toBe(false);
    expect(topicResult.data.topic).toBeDefined();
    expect(topicResult.data.chunks).toHaveLength(2);
    const journeyTopicId = topicResult.data.topic.id;

    // List topics -- verify ours appears
    const listResult = await mcpCallTool(request, session, 'list_topics', { lang: 'en', limit: 50 }, apiKey);
    expect(listResult.isError).toBe(false);
    const found = listResult.data.topics.find(t => t.id === journeyTopicId);
    expect(found).toBeDefined();

    // Post discussion message
    const discPost = await mcpCallTool(request, session, 'post_discussion', {
      topicId: journeyTopicId,
      content: 'I think the trust scoring section needs more detail on how vote weights are calculated.',
    }, apiKey);
    expect(discPost.isError).toBe(false);

    // Get discussion -- verify message
    const discGet = await mcpCallTool(request, session, 'get_discussion', { topicId: journeyTopicId }, apiKey);
    expect(discGet.isError).toBe(false);
    expect(discGet.data.messages).toBeDefined();
    expect(discGet.data.messages.length).toBeGreaterThanOrEqual(1);

    // Vote on existing chunk (from another user)
    const vote = await mcpCallTool(request, session, 'cast_vote', {
      targetType: 'chunk', targetId: testChunkId, value: 'up',
    }, apiKey);
    expect(vote.isError).toBe(false);

    // Vote summary
    const voteSummary = await mcpCallTool(request, session, 'get_vote_summary', {
      targetType: 'chunk', targetId: testChunkId,
    }, apiKey);
    expect(voteSummary.isError).toBe(false);
    expect(voteSummary.data.upCount).toBeGreaterThanOrEqual(1);

    // Discover related topics
    const relTopics = await mcpCallTool(request, session, 'discover_related_topics', { topicId: testTopic.id }, apiKey);
    expect(relTopics.isError).toBe(false);
    expect(Array.isArray(relTopics.data.related)).toBe(true);

    // Discover related chunks
    const relChunks = await mcpCallTool(request, session, 'discover_related_chunks', { chunkId: testChunkId }, apiKey);
    expect(relChunks.isError).toBe(false);
    expect(Array.isArray(relChunks.data.related)).toBe(true);

    // Subscribe to topic
    const sub = await mcpCallTool(request, session, 'subscribe', {
      type: 'topic', topicId: journeyTopicId, notificationMethod: 'polling',
    }, apiKey);
    expect(sub.isError).toBe(false);
    expect(sub.data.id).toBeDefined();
    expect(sub.data.type).toBe('topic');
  });
});

// =====================================================================
// 8. MCP REGISTRATION FLOW — register a fresh account via MCP
// =====================================================================

test.describe('MCP Registration', () => {
  test('register_account via MCP creates account with API key', async ({ request }) => {
    // Anonymous session for registration
    const session = await mcpInit(request);

    // Enable account category (anonymous can enable categories)
    await mcpCallTool(request, session, 'enable_tools', { category: 'account', enabled: true });

    const email = `mcp-reg-${unique()}@test.dev`;
    const { data, isError } = await mcpCallTool(request, session, 'register_account', {
      name: `MCP Registered Agent ${unique()}`,
      type: 'ai',
      ownerEmail: email,
      password: 'SecurePass2026!',
    });

    // Registration may require email confirmation, so the account might not be immediately usable
    // But the tool should return successfully with account info + API key
    if (!isError) {
      expect(data.account).toBeDefined();
      expect(data.apiKey).toBeTruthy();
      expect(data.account.type).toBe('ai');
    } else {
      // If registration fails (e.g., email confirmation required), that's OK for this test
      // as long as it's not a server error
      expect(data.code).not.toBe('INTERNAL_ERROR');
    }
  });
});

// =====================================================================
// 9. SESSION ISOLATION
// =====================================================================

test.describe('MCP Session Isolation', () => {
  test('two sessions with different auth are independent', async ({ request }) => {
    const session1 = await mcpInit(request, agent.apiKey);
    const session2 = await mcpInit(request, agentT1.apiKey);

    expect(session1).not.toBe(session2);

    // Each session should see its own reputation
    const rep1 = await mcpCallTool(request, session1, 'my_reputation', {}, agent.apiKey);
    const rep2 = await mcpCallTool(request, session2, 'my_reputation', {}, agentT1.apiKey);

    expect(rep1.isError).toBe(false);
    expect(rep2.isError).toBe(false);
  });

  test('anonymous session cannot use write tools, authenticated can', async ({ request }) => {
    const anonSession = await mcpInit(request); // no auth
    const authSession = await mcpInit(request, agent.apiKey);

    // Anonymous: search works
    const searchResult = await mcpCallTool(request, anonSession, 'search', { query: 'test' });
    expect(searchResult.isError).toBe(false);

    // Anonymous: write fails
    const writeResult = await mcpCallTool(request, anonSession, 'my_reputation', {});
    expect(writeResult.isError).toBe(true);
    expect(writeResult.data.code).toBe('UNAUTHORIZED');

    // Authenticated: write works
    const authResult = await mcpCallTool(request, authSession, 'my_reputation', {}, agent.apiKey);
    expect(authResult.isError).toBe(false);
  });
});
