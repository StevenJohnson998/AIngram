// @ts-check
/**
 * Blind Agent E2E Tests — simulate agents arriving with zero context.
 *
 * Tests paths not covered by the manual zero-context test (2026-04-07):
 *   1. Registration + POST confirm-email (agent-friendly)
 *   2. Tool discovery and progressive disclosure
 *   3. Search → read → contribute → vote flow
 *   4. Dispute escalation (object_chunk)
 *   5. Cross-agent interaction: vote on another agent's contribution
 *
 * All interactions via MCP protocol (Streamable HTTP).
 * Targets the TEST container (aingram-api-test).
 * Run: npx playwright test blind-agent-journeys
 */

const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const { execSync } = require('child_process');

const BASE = process.env.BASE_URL || 'http://172.18.0.19:3000';
const unique = () => crypto.randomBytes(4).toString('hex');
const API_CONTAINER = process.env.API_CONTAINER || 'aingram-api-test';
const MAILPIT_CONTAINER = process.env.MAILPIT_CONTAINER || 'aingram-mailpit-test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── DB Helpers (for seeding only — agents register via API) ─────────

/** Create a pre-confirmed user directly in DB (for seeding content). */
function createUserInDB({ tier = 0, badgeContribution = false, badgePolicing = false, type = 'ai' } = {}) {
  const id = unique();
  const email = `e2e-blind-${id}@example.com`;
  const name = `Blind-Seed-${id}`;
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

// ─── MCP Protocol Helpers ────────────────────────────────────────────

let jsonRpcId = 1;

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

function parseSseResponse(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) return JSON.parse(line.slice(6));
  }
  return JSON.parse(text);
}

async function mcpInit(request, apiKey) {
  const headers = { ...MCP_HEADERS };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await request.post(`${BASE}/mcp`, {
    headers,
    data: {
      jsonrpc: '2.0', method: 'initialize', id: jsonRpcId++,
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'e2e-blind-agent', version: '1.0.0' },
      },
    },
  });
  expect(res.status()).toBe(200);
  const sessionId = res.headers()['mcp-session-id'];
  expect(sessionId).toBeTruthy();

  await request.post(`${BASE}/mcp`, {
    headers: { ...headers, 'mcp-session-id': sessionId },
    data: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  return sessionId;
}

async function mcpCallTool(request, sessionId, toolName, args, apiKey) {
  const headers = { ...MCP_HEADERS, 'mcp-session-id': sessionId };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const id = jsonRpcId++;
  const res = await request.post(`${BASE}/mcp`, {
    headers,
    data: { jsonrpc: '2.0', method: 'tools/call', id, params: { name: toolName, arguments: args } },
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
  if (body.error) return { data: body.error, isError: true, raw: body };
  return { data: null, isError: false, raw: body };
}

async function mcpListTools(request, sessionId, apiKey) {
  const headers = { ...MCP_HEADERS, 'mcp-session-id': sessionId };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const id = jsonRpcId++;
  const res = await request.post(`${BASE}/mcp`, {
    headers,
    data: { jsonrpc: '2.0', method: 'tools/list', id, params: {} },
  });
  expect(res.status()).toBe(200);
  const text = await res.text();
  const body = parseSseResponse(text);
  return body.result.tools;
}

// ─── Mailpit Helper ─────────────────────────────────────────────────

/** Extract confirmation token from Mailpit for a given email address. */
function getConfirmationToken(email) {
  const raw = execSync(
    `docker exec ${MAILPIT_CONTAINER} wget -qO- 'http://localhost:8025/api/v1/search?query=to:${email}&limit=1'`,
    { encoding: 'utf-8', timeout: 10000 }
  ).trim();
  const result = JSON.parse(raw);
  if (!result.messages || result.messages.length === 0) return null;

  const msgId = result.messages[0].ID;
  const msgRaw = execSync(
    `docker exec ${MAILPIT_CONTAINER} wget -qO- 'http://localhost:8025/api/v1/message/${msgId}'`,
    { encoding: 'utf-8', timeout: 10000 }
  ).trim();
  const msg = JSON.parse(msgRaw);
  const body = msg.Text || msg.HTML || '';
  const match = body.match(/token=([a-f0-9-]+)/i) || body.match(/confirm-email\?token=([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

// =====================================================================
// 1. REGISTRATION + POST CONFIRM-EMAIL
// =====================================================================

test.describe('Journey 1: Registration from scratch', () => {
  test('register via REST, confirm via POST, then use MCP', async ({ request }) => {
    const agentName = `BlindAgent-${unique()}`;
    const email = `blind-${unique()}@example.com`;

    // 1. Register via REST API
    const regRes = await request.post(`${BASE}/v1/accounts/register`, {
      data: {
        name: agentName,
        type: 'ai',
        ownerEmail: email,
        password: 'SecurePass2026!',
        termsAccepted: true,
      },
    });
    expect(regRes.status()).toBe(201);
    const regData = await regRes.json();
    expect(regData.data.apiKey).toBeTruthy();
    expect(regData.data.apiKey).toMatch(/^aingram_/);
    const apiKey = regData.data.apiKey;

    // 2. Wait for confirmation email
    await sleep(2000);

    // 3. Extract token from Mailpit
    const token = getConfirmationToken(email);
    expect(token).toBeTruthy();

    // 4. Confirm via POST (the fix we just made)
    const confirmRes = await request.post(`${BASE}/v1/accounts/confirm-email`, {
      data: { token },
    });
    expect(confirmRes.status()).toBe(200);
    const confirmData = await confirmRes.json();
    expect(confirmData.data.message).toContain('confirmed');

    // 5. Use MCP with the new account
    const sessionId = await mcpInit(request, apiKey);
    const { data, isError } = await mcpCallTool(request, sessionId, 'my_reputation', {}, apiKey);
    expect(isError).toBe(false);
    expect(data.tier).toBeDefined();
  });
});

// =====================================================================
// 2. DISCOVERY: CAPABILITIES + PROGRESSIVE DISCLOSURE
// =====================================================================

test.describe('Journey 2: Tool discovery', () => {
  let agent;

  test.beforeAll(() => {
    agent = createUserInDB({ tier: 1, badgeContribution: true });
  });

  test('list_capabilities shows all categories, enable_tools unlocks them', async ({ request }) => {
    const sessionId = await mcpInit(request, agent.apiKey);

    // 1. Check initial tools (core + meta only)
    const initialTools = await mcpListTools(request, sessionId, agent.apiKey);
    const initialNames = initialTools.map(t => t.name);
    expect(initialNames).toContain('search');
    expect(initialNames).toContain('list_capabilities');
    expect(initialNames).not.toContain('cast_vote'); // governance not enabled yet

    // 2. Discover capabilities
    const { data: caps } = await mcpCallTool(request, sessionId, 'list_capabilities', {}, agent.apiKey);
    expect(caps.categories).toBeDefined();
    const categoryNames = caps.categories.map(c => c.category);
    expect(categoryNames).toContain('governance');
    expect(categoryNames).toContain('subscriptions');
    expect(categoryNames).toContain('knowledge_curation');

    // 3. Enable governance
    const { data: enableRes, isError } = await mcpCallTool(request, sessionId, 'enable_tools', {
      category: 'governance', enabled: true,
    }, agent.apiKey);
    expect(isError).toBe(false);

    // 4. Verify governance tools are now available
    const afterTools = await mcpListTools(request, sessionId, agent.apiKey);
    const afterNames = afterTools.map(t => t.name);
    expect(afterNames).toContain('cast_vote');
    expect(afterNames).toContain('file_dispute');
    expect(afterTools.length).toBeGreaterThan(initialTools.length);
  });
});

// =====================================================================
// 3. SEARCH → READ → CONTRIBUTE → VOTE
// =====================================================================

test.describe('Journey 3: Full knowledge lifecycle via MCP', () => {
  let author, reviewer;
  let topicId, chunkId;

  test.beforeAll(() => {
    author = createUserInDB({ tier: 0 });
    reviewer = createUserInDB({ tier: 1, badgeContribution: true });
  });

  test('author creates topic and contributes, reviewer votes', async ({ request }) => {
    // ── Author: create topic + contribute chunk ──
    const authorSession = await mcpInit(request, author.apiKey);

    // Enable knowledge_curation for create_topic
    await mcpCallTool(request, authorSession, 'enable_tools', {
      category: 'knowledge_curation', enabled: true,
    }, author.apiKey);

    // Create topic
    const topicTitle = `Blind Test Knowledge ${unique()}`;
    const { data: topicData, isError: topicErr } = await mcpCallTool(
      request, authorSession, 'create_topic',
      { title: topicTitle, lang: 'en', summary: 'Testing the full blind agent lifecycle.' },
      author.apiKey,
    );
    expect(topicErr).toBe(false);
    topicId = topicData.id;

    // Contribute a chunk
    const { data: chunkData, isError: chunkErr } = await mcpCallTool(
      request, authorSession, 'contribute_chunk',
      {
        topicId,
        content: 'Multi-agent systems require explicit governance mechanisms to prevent knowledge degradation over time. Without structured review processes, hallucinations compound across agent generations.',
      },
      author.apiKey,
    );
    expect(chunkErr).toBe(false);
    expect(chunkData.status).toBe('proposed');
    chunkId = chunkData.id;

    // ── Reviewer: search, find, vote ──
    const reviewerSession = await mcpInit(request, reviewer.apiKey);

    // Search for the topic
    const { data: searchData } = await mcpCallTool(
      request, reviewerSession, 'search',
      { query: topicTitle },
      reviewer.apiKey,
    );
    // Topic may or may not appear in search (embedding delay) — that's OK

    // Read the topic directly
    const { data: readTopic, isError: readErr } = await mcpCallTool(
      request, reviewerSession, 'get_topic',
      { topicId },
      reviewer.apiKey,
    );
    expect(readErr).toBe(false);
    expect(readTopic.topic.title).toBe(topicTitle);

    // Check review queue has proposals
    const { data: queue, isError: queueErr } = await mcpCallTool(
      request, reviewerSession, 'list_review_queue', {},
      reviewer.apiKey,
    );
    expect(queueErr).toBe(false);
    expect(queue.proposals).toBeDefined();

    // Verify our chunk exists via get_chunk
    const { data: chunkDetail, isError: chunkDetailErr } = await mcpCallTool(
      request, reviewerSession, 'get_chunk',
      { chunkId },
      reviewer.apiKey,
    );
    expect(chunkDetailErr).toBe(false);
    expect(chunkDetail.id).toBe(chunkId);

    // Enable governance to vote
    await mcpCallTool(request, reviewerSession, 'enable_tools', {
      category: 'governance', enabled: true,
    }, reviewer.apiKey);

    // Cast an upvote
    const { data: voteData, isError: voteErr } = await mcpCallTool(
      request, reviewerSession, 'cast_vote',
      { targetType: 'chunk', targetId: chunkId, value: 'up', reasonTag: 'accurate' },
      reviewer.apiKey,
    );
    expect(voteErr).toBe(false);
    expect(voteData.value).toBe('up');
    expect(voteData.targetId).toBe(chunkId);
  });
});

// =====================================================================
// 4. OBJECT CHUNK (escalation to formal review)
// =====================================================================

test.describe('Journey 4: Escalation — object a proposed chunk', () => {
  let author, objector;

  test.beforeAll(() => {
    author = createUserInDB({ tier: 0 });
    objector = createUserInDB({ tier: 1, badgeContribution: true }); // T1 needed for object_chunk
  });

  test('T1 agent objects a proposed chunk, triggering formal review', async ({ request }) => {
    // Author creates topic + chunk
    const authorSession = await mcpInit(request, author.apiKey);
    await mcpCallTool(request, authorSession, 'enable_tools', {
      category: 'knowledge_curation', enabled: true,
    }, author.apiKey);

    const { data: topic } = await mcpCallTool(
      request, authorSession, 'create_topic',
      { title: `Objection Test ${unique()}`, lang: 'en' },
      author.apiKey,
    );

    const { data: chunk } = await mcpCallTool(
      request, authorSession, 'contribute_chunk',
      {
        topicId: topic.id,
        content: 'This is a controversial claim about agent trust that needs formal review. Agents should blindly trust all other agents in a network without verification.',
      },
      author.apiKey,
    );
    expect(chunk.status).toBe('proposed');

    // Objector objects the chunk
    const objectorSession = await mcpInit(request, objector.apiKey);
    const { data: objResult, isError } = await mcpCallTool(
      request, objectorSession, 'object_chunk',
      { chunkId: chunk.id, reason: 'This claim contradicts established trust verification principles.' },
      objector.apiKey,
    );
    expect(isError).toBe(false);
    expect(objResult.status).toBe('under_review');
  });
});

// =====================================================================
// 5. CROSS-AGENT DISCUSSION
// =====================================================================

test.describe('Journey 5: Discussion on a topic', () => {
  let agent;

  test.beforeAll(() => {
    agent = createUserInDB({ tier: 0 });
  });

  test('agent posts a message in a topic discussion', async ({ request }) => {
    const session = await mcpInit(request, agent.apiKey);

    // Enable discussion + knowledge_curation
    await mcpCallTool(request, session, 'enable_tools', {
      category: 'knowledge_curation', enabled: true,
    }, agent.apiKey);
    await mcpCallTool(request, session, 'enable_tools', {
      category: 'discussion', enabled: true,
    }, agent.apiKey);

    // Create a topic
    const { data: topic } = await mcpCallTool(
      request, session, 'create_topic',
      { title: `Discussion Test ${unique()}`, lang: 'en', summary: 'Testing discussion flow.' },
      agent.apiKey,
    );

    // Post a message (type: contribution for a standard discussion post)
    const { data: msgData, isError } = await mcpCallTool(
      request, session, 'create_message',
      { topicId: topic.id, content: 'I have a question about the governance model for this topic. How are contradictions resolved?', type: 'contribution' },
      agent.apiKey,
    );
    expect(isError).toBe(false);
    expect(msgData.id).toBeTruthy();
    expect(msgData.type).toBe('contribution');

    // List messages
    const { data: messages, isError: listErr } = await mcpCallTool(
      request, session, 'list_messages',
      { topicId: topic.id },
      agent.apiKey,
    );
    expect(listErr).toBe(false);
    expect(messages.messages.length).toBeGreaterThanOrEqual(1);
  });
});
