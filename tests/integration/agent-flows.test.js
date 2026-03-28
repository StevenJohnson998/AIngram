/**
 * Agent flow integration tests — run against live AIngram API.
 * Tests autonomous agents, assisted agents, and cross-agent interactions.
 */

const http = require('http');
const { Pool } = require('pg');

const API_HOST = '127.0.0.1';
const API_PORT = 3000;
const DATABASE_URL = process.env.DATABASE_URL ||
  `postgresql://${process.env.DB_USER || 'admin'}:${process.env.DB_PASSWORD}@${process.env.DB_HOST || 'postgres'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'aingram_test'}`;

let pool;
const ts = Date.now();
const createdAccountIds = [];

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json', ...headers };
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ hostname: API_HOST, port: API_PORT, path, method, headers: h }, res => {
      let chunks = '';
      const setCookie = res.headers['set-cookie'];
      res.on('data', c => chunks += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
        resolve({ status: res.statusCode, data: parsed, setCookie });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  if (createdAccountIds.length > 0) {
    await pool.query('DELETE FROM votes WHERE account_id = ANY($1)', [createdAccountIds]);
    await pool.query('DELETE FROM chunk_topics WHERE chunk_id IN (SELECT id FROM chunks WHERE created_by = ANY($1))', [createdAccountIds]);
    await pool.query('DELETE FROM chunks WHERE created_by = ANY($1)', [createdAccountIds]);
    await pool.query('DELETE FROM connection_tokens WHERE account_id = ANY($1)', [createdAccountIds]);
    await pool.query('DELETE FROM messages WHERE account_id = ANY($1)', [createdAccountIds]);
    // Delete topics created by test accounts
    await pool.query('DELETE FROM topic_translations WHERE topic_id IN (SELECT id FROM topics WHERE created_by = ANY($1))', [createdAccountIds]);
    await pool.query('DELETE FROM topics WHERE created_by = ANY($1)', [createdAccountIds]);
    await pool.query('DELETE FROM sanctions WHERE account_id = ANY($1)', [createdAccountIds]);
    await pool.query('DELETE FROM activity_log WHERE account_id = ANY($1)', [createdAccountIds]);
    await pool.query('DELETE FROM accounts WHERE parent_id = ANY($1)', [createdAccountIds]);
    await pool.query('DELETE FROM accounts WHERE id = ANY($1)', [createdAccountIds]);
  }
  await pool.end();
});

// Shared state between sequential tests
const state = {};

describe('Autonomous AI Agent', () => {
  it('registers with type=ai and gets API key', async () => {
    const res = await request('POST', '/accounts/register', {
      name: `AutoBot-${ts}`,
      type: 'ai',
      ownerEmail: `autobot-${ts}@test.local`,
      password: 'SecurePass123!',
      termsAccepted: true,
    });
    expect(res.status).toBe(201);
    expect(res.data.data.apiKey).toMatch(/^aingram_[0-9a-f]{8}_/);
    state.autoKey = res.data.data.apiKey;
    state.autoId = res.data.data.account.id;
    createdAccountIds.push(state.autoId);

    await pool.query("UPDATE accounts SET status = 'active', email_confirmed = true WHERE id = $1", [state.autoId]);
  });

  it('authenticates with Bearer API key on /accounts/me', async () => {
    const res = await request('GET', '/accounts/me', null, {
      Authorization: `Bearer ${state.autoKey}`,
    });
    expect(res.status).toBe(200);
    expect(res.data.data.account.id).toBe(state.autoId);
    expect(res.data.data.account.type).toBe('ai');
  });

  it('creates a topic', async () => {
    const res = await request('POST', '/topics', {
      title: `Test Topic by Autonomous Agent ${ts}`,
      summary: 'Testing autonomous agent capabilities',
      sensitivity: 'low',
      lang: 'en',
    }, { Authorization: `Bearer ${state.autoKey}` });
    expect(res.status).toBe(201);
    state.topicId = res.data.data.id;
    expect(state.topicId).toBeDefined();
  });

  it('creates a chunk on the topic', async () => {
    const res = await request('POST', `/topics/${state.topicId}/chunks`, {
      content: 'MCP (Model Context Protocol) is an open protocol by Anthropic for connecting LLMs to external tools and data sources.',
    }, { Authorization: `Bearer ${state.autoKey}` });
    expect(res.status).toBe(201);
    state.chunkId = res.data.data.id;
    expect(state.chunkId).toBeDefined();
    expect(res.data.data.status).toBe('proposed'); // Sprint 1: chunks start as proposed
  });

  it('rejects invalid API key', async () => {
    const res = await request('POST', '/topics', {
      title: 'Should fail', lang: 'en',
    }, { Authorization: 'Bearer aingram_fake1234_000000000000000000000000' });
    expect(res.status).toBe(401);
  });
});

describe('Human + Assisted Agent', () => {
  it('registers human account', async () => {
    const res = await request('POST', '/accounts/register', {
      name: `Human-${ts}`,
      type: 'human',
      ownerEmail: `human-${ts}@test.local`,
      password: 'HumanPass123!',
      termsAccepted: true,
    });
    expect(res.status).toBe(201);
    state.humanKey = res.data.data.apiKey;
    state.humanId = res.data.data.account.id;
    createdAccountIds.push(state.humanId);

    await pool.query("UPDATE accounts SET status = 'active', email_confirmed = true WHERE id = $1", [state.humanId]);
  });

  it('human logs in and gets JWT cookie', async () => {
    const res = await request('POST', '/accounts/login', {
      email: `human-${ts}@test.local`,
      password: 'HumanPass123!',
    });
    expect(res.status).toBe(200);
    expect(res.setCookie).toBeDefined();
    state.cookie = res.setCookie[0].split(';')[0];
    expect(state.cookie).toMatch(/aingram_token=/);
  });

  it('human creates an assisted agent', async () => {
    const res = await request('POST', '/accounts/me/agents', {
      name: `AssistedBot-${ts}`,
      description: 'An AI agent that helps research topics',
    }, { Cookie: state.cookie });
    expect(res.status).toBe(201);
    // Response may wrap in data.account or data directly
    const agentData = res.data.data.account || res.data.data;
    state.assistedId = agentData.id;
    createdAccountIds.push(state.assistedId);
    expect(agentData.type).toBe('ai');
  });

  it('generates connection token and connects assisted agent', async () => {
    const tokenRes = await request('POST', `/accounts/me/agents/${state.assistedId}/connection-token`, {}, {
      Cookie: state.cookie,
    });
    expect(tokenRes.status).toBe(201);
    expect(tokenRes.data.data.token).toBeDefined();

    const connRes = await request('POST', '/accounts/connect', {
      token: tokenRes.data.data.token,
    });
    expect([200, 201]).toContain(connRes.status);
    state.assistedKey = connRes.data.data.apiKey;
    expect(state.assistedKey).toMatch(/^aingram_/);

    await pool.query("UPDATE accounts SET status = 'active', email_confirmed = true WHERE id = $1", [state.assistedId]);
  });

  it('assisted agent authenticates and sees its parent', async () => {
    const res = await request('GET', '/accounts/me', null, {
      Authorization: `Bearer ${state.assistedKey}`,
    });
    expect(res.status).toBe(200);
    expect(res.data.data.account.parent_id).toBe(state.humanId);
  });

  it('assisted agent creates chunk', async () => {
    const res = await request('POST', `/topics/${state.topicId}/chunks`, {
      content: 'Agent-to-Agent (A2A) protocol by Google enables inter-agent communication with task lifecycle management.',
    }, { Authorization: `Bearer ${state.assistedKey}` });
    expect(res.status).toBe(201);
    state.assistedChunkId = res.data.data.id;
    expect(res.data.data.status).toBe('proposed');
  });
});

describe('Cross-agent voting (Bug 1 validation)', () => {
  it('agent votes up on another agent chunk', async () => {
    // Give autoBot a first_contribution so voting is unlocked
    await pool.query("UPDATE accounts SET first_contribution_at = COALESCE(first_contribution_at, now()) WHERE id = $1", [state.autoId]);

    // AutoBot votes on AssistedBot's chunk
    const res = await request('POST', '/votes', {
      target_type: 'chunk',
      target_id: state.assistedChunkId,
      value: 'up',
      reason_tag: 'accurate',
    }, { Authorization: `Bearer ${state.autoKey}` });
    expect(res.status).toBe(201);
    expect(res.data.data.value).toBe('up');
    expect(res.data.data.weight).toBeGreaterThan(0);
  });

  it('self-vote on own chunk is blocked', async () => {
    const res = await request('POST', '/votes', {
      target_type: 'chunk',
      target_id: state.chunkId, // AutoBot's own chunk
      value: 'up',
      reason_tag: 'accurate',
    }, { Authorization: `Bearer ${state.autoKey}` });
    // SELF_VOTE error can come as 400 or 403 depending on route error handling
    expect([400, 403]).toContain(res.status);
    expect(res.data.error.code).toBe('SELF_VOTE');
  });

  it('vote on retracted chunk is blocked', async () => {
    // Retract the assisted chunk temporarily
    await pool.query("UPDATE chunks SET status = 'retracted' WHERE id = $1", [state.assistedChunkId]);

    const res = await request('POST', '/votes', {
      target_type: 'chunk',
      target_id: state.assistedChunkId,
      value: 'up',
      reason_tag: 'accurate',
    }, { Authorization: `Bearer ${state.autoKey}` });
    expect([400, 403]).toContain(res.status);

    // Restore
    await pool.query("UPDATE chunks SET status = 'active' WHERE id = $1", [state.assistedChunkId]);
  });

  it('vote list shows the cast vote', async () => {
    const res = await request('GET', `/votes?target_type=chunk&target_id=${state.assistedChunkId}`, null, {
      Authorization: `Bearer ${state.autoKey}`,
    });
    expect(res.status).toBe(200);
    expect(res.data.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Banned agent rejection', () => {
  it('banned agent is rejected with 401', async () => {
    const regRes = await request('POST', '/accounts/register', {
      name: `Banned-${ts}`,
      type: 'ai',
      ownerEmail: `banned-${ts}@test.local`,
      password: 'BannedPass123!',
      termsAccepted: true,
    });
    const bannedKey = regRes.data.data.apiKey;
    const bannedId = regRes.data.data.account.id;
    createdAccountIds.push(bannedId);

    await pool.query("UPDATE accounts SET status = 'banned' WHERE id = $1", [bannedId]);

    const res = await request('GET', '/accounts/me', null, {
      Authorization: `Bearer ${bannedKey}`,
    });
    expect(res.status).toBe(401);
  });
});

describe('Provisional agent restrictions', () => {
  it('provisional agent cannot vote', async () => {
    const regRes = await request('POST', '/accounts/register', {
      name: `Provisional-${ts}`,
      type: 'ai',
      ownerEmail: `provisional-${ts}@test.local`,
      password: 'ProvPass123!',
      termsAccepted: true,
    });
    const provKey = regRes.data.data.apiKey;
    const provId = regRes.data.data.account.id;
    createdAccountIds.push(provId);

    // Don't activate — stays provisional
    await pool.query("UPDATE accounts SET first_contribution_at = now() WHERE id = $1", [provId]);

    const res = await request('POST', '/votes', {
      target_type: 'chunk',
      target_id: state.chunkId,
      value: 'up',
      reason_tag: 'accurate',
    }, { Authorization: `Bearer ${provKey}` });
    // Provisional accounts rejected — service returns FORBIDDEN, route may return 400 or 403
    expect([400, 403]).toContain(res.status);
  });
});
