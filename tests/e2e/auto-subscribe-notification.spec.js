// @ts-check
/**
 * Auto-subscribe + notification E2E test.
 *
 * Scenario:
 *   1. Agent A creates a topic via MCP → auto-subscribed
 *   2. Agent B contributes a chunk on that topic via MCP
 *   3. Agent A polls notifications via MCP → sees the contribution
 *
 * Targets the TEST container (aingram-api-test).
 * Run: npx playwright test auto-subscribe-notification
 */

const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const { execSync } = require('child_process');

const BASE = process.env.BASE_URL || 'http://172.18.0.19:3000';
const unique = () => crypto.randomBytes(4).toString('hex');
const API_CONTAINER = process.env.API_CONTAINER || 'aingram-api-test';

// ─── Helpers ─────────────────────────────────────────────────────────

function createUserInDB({ tier = 0, type = 'ai' } = {}) {
  const id = unique();
  const email = `e2e-autosub-${id}@example.com`;
  const name = `AutoSub-Agent-${id}`;
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
         VALUES ($1,$2,$3,$4,$5,$6,true,$7,false,false,0.5,0.5,now(),$8,$9,$10)\`,
        [accountId, '${name}', '${type}', '${email}', pwHash, 'active',
         parseInt('${tier}'), '2026-03-21-v1', keyHash, prefix]
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
    if (line.startsWith('data: ')) {
      return JSON.parse(line.slice(6));
    }
  }
  return JSON.parse(text);
}

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
        clientInfo: { name: 'e2e-autosub-test', version: '1.0.0' },
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

// ─── Test ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.describe('Auto-subscribe & Notification Flow', () => {
  let agentA, agentB;
  let sessionA, sessionB;

  test.beforeAll(async () => {
    agentA = createUserInDB({ tier: 0, type: 'ai' });
    agentB = createUserInDB({ tier: 0, type: 'ai' });
  });

  test('Agent A creates topic via MCP, Agent B contributes, Agent A gets notified', async ({ request }) => {
    // 1. Both agents init MCP sessions
    sessionA = await mcpInit(request, agentA.apiKey);
    sessionB = await mcpInit(request, agentB.apiKey);

    // 2. Agent A enables knowledge_curation tools (needed for create_topic)
    const enableRes = await mcpCallTool(request, sessionA, 'enable_tools', {
      category: 'knowledge_curation',
      enabled: true,
    }, agentA.apiKey);
    expect(enableRes.isError).toBe(false);

    // 3. Agent A creates a topic
    const topicTitle = `Auto-Subscribe Test ${unique()}`;
    const createRes = await mcpCallTool(request, sessionA, 'create_topic', {
      title: topicTitle,
      lang: 'en',
      summary: 'Testing that topic creators are auto-subscribed and receive notifications.',
    }, agentA.apiKey);
    expect(createRes.isError).toBe(false);
    expect(createRes.data.id).toBeTruthy();
    expect(createRes.data.title).toBe(topicTitle);
    const topicId = createRes.data.id;

    // 4. Wait for auto-subscribe fire-and-forget to complete
    await sleep(1500);

    // 5. Verify Agent A is subscribed (poll should return empty but not error)
    const pollBefore = await mcpCallTool(request, sessionA, 'poll_notifications', {}, agentA.apiKey);
    expect(pollBefore.isError).toBe(false);
    expect(pollBefore.data.notifications).toBeDefined();

    // 6. Agent B contributes a chunk on Agent A's topic
    const contributeRes = await mcpCallTool(request, sessionB, 'contribute_chunk', {
      topicId,
      content: 'Multi-agent knowledge governance requires transparent review processes. This contribution tests the notification pipeline from contributor to topic creator.',
    }, agentB.apiKey);
    expect(contributeRes.isError).toBe(false);
    expect(contributeRes.data.status).toBe('proposed');
    const chunkId = contributeRes.data.id;

    // 7. Wait for subscription matching fire-and-forget
    await sleep(1500);

    // 8. Agent A polls notifications → should see Agent B's contribution
    const pollAfter = await mcpCallTool(request, sessionA, 'poll_notifications', {
      since: new Date(Date.now() - 60000).toISOString(),
    }, agentA.apiKey);
    expect(pollAfter.isError).toBe(false);
    expect(pollAfter.data.notifications.length).toBeGreaterThanOrEqual(1);

    // Find the notification for Agent B's chunk
    const notification = pollAfter.data.notifications.find(n => n.chunkId === chunkId);
    expect(notification).toBeTruthy();
    expect(notification.matchType).toBe('topic');
    expect(notification.contentPreview).toBeTruthy();
  });
});
