// @ts-check
/**
 * GUI Assisted Agent E2E Test
 *
 * CONSTRAINT: This test ONLY uses endpoints and actions accessible from the GUI.
 * No direct DB inserts, no JWT generation, no internal service calls.
 * The human controls an assisted agent entirely through the GUI (REST API
 * endpoints that the frontend JavaScript calls via api.js).
 *
 * ONLY EXCEPTION: Mailpit API is used to retrieve the confirmation email token.
 * This is the equivalent of "the user checks their inbox" — there is no other
 * way to complete email confirmation in a test environment.
 *
 * This simulates the real user experience:
 *   1. Human registers via register.html form
 *   2. Human confirms email via confirm-email.html
 *   3. Human logs in via login.html form
 *   4. Human creates an assisted agent via settings.html#agents
 *   5. Human creates an article via new-article.html (agent contributes)
 *   6. Human views the article via topic.html
 *   7. Human searches via search.html
 *   8. Human votes on existing content via topic.html
 *   9. Human posts a discussion message via topic.html
 *  10. Human subscribes the agent to a topic via settings.html#subscriptions
 *  11. Human checks contributions via profile.html
 *
 * WHY: Agents that operate via MCP/API have their own tests (blind-agent-journeys).
 * This test validates the human-in-the-loop path where the GUI is the only interface.
 * Any endpoint not reachable from the GUI frontend code should NOT be used here.
 *
 * GUI endpoints used (from api.js):
 *   POST /accounts/register       — register.html form
 *   POST /accounts/confirm-email   — confirm-email.html
 *   POST /accounts/login           — login.html form
 *   GET  /accounts/me              — navbar auth check
 *   POST /accounts/me/agents       — settings.html agent creation
 *   GET  /accounts/me/agents       — settings.html agent list
 *   GET  /accounts/me/contributions — profile.html contributions tab
 *   GET  /topics                    — index.html topic list
 *   GET  /topics/:id               — topic.html
 *   GET  /topics/:id/chunks        — topic.html content + pending
 *   GET  /topics/:id/messages      — topic.html discussion tab
 *   GET  /topics/:id/history       — topic.html history tab
 *   POST /topics/full              — new-article.html publish
 *   GET  /search                   — search.html
 *   POST /votes                    — topic.html vote buttons
 *   POST /topics/:id/messages      — topic.html discussion form
 *   POST /subscriptions            — settings.html subscription form
 *   GET  /subscriptions/notifications — notifications.html
 *   GET  /reviews/pending           — review-queue.html
 *   GET  /accounts/:id             — profile.html
 *   GET  /activity                 — index.html activity feed
 *   GET  /analytics/hot-topics     — index.html / hot-topics.html
 *   GET  /debates                  — debates.html
 */

const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const http = require('http');

const BASE = process.env.BASE_URL || 'http://172.18.0.19:3000';
const MAILPIT = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';
const unique = () => crypto.randomBytes(4).toString('hex');

// --- HTTP helper (simulates api.js fetch calls) ---

function apiCall(method, path, body, cookieStr) {
  return new Promise((resolve) => {
    const url = new URL(path, BASE);
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method, headers: { 'Content-Type': 'application/json' },
    };
    if (data && method !== 'GET') opts.headers['Content-Length'] = Buffer.byteLength(data);
    if (cookieStr) opts.headers.Cookie = cookieStr;
    const r = http.request(opts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        const cookies = res.headers['set-cookie'] || [];
        const tokenCookie = cookies.find((c) => c.startsWith('aingram_token='));
        let parsed = {};
        try { parsed = JSON.parse(b); } catch { parsed = { raw: b.substring(0, 200) }; }
        // Unwrap envelope (same logic as api.js _unwrap)
        let result;
        if (parsed.error) {
          result = { status: res.statusCode, data: parsed, error: parsed.error };
        } else if (Array.isArray(parsed.data)) {
          result = { status: res.statusCode, data: parsed.data, pagination: parsed.pagination };
        } else if (parsed.data !== undefined) {
          result = { status: res.statusCode, data: parsed.data, pagination: parsed.pagination };
        } else {
          result = { status: res.statusCode, data: parsed };
        }
        if (tokenCookie) result.cookie = tokenCookie.split(';')[0];
        resolve(result);
      });
    });
    if (data && method !== 'GET') r.write(data);
    r.end();
  });
}

function mailpitGet(path) {
  return new Promise((resolve) => {
    http.get(MAILPIT + path, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(JSON.parse(b)));
    });
  });
}

test.describe('GUI Assisted Agent — full human journey', () => {
  test.describe.configure({ mode: 'serial', timeout: 30000 });

  const EMAIL = `gui-agent-${unique()}@example.com`;
  const PASSWORD = 'SecureP@ss42!';
  const NAME = `GUI Agent Test ${unique()}`;
  let cookie;
  let me;
  let agent;
  let createdTopicId;
  let createdChangesetId;
  let existingTopicId;

  test('1. Register via GUI form', async () => {
    const res = await apiCall('POST', '/v1/accounts/register', {
      name: NAME, type: 'human', ownerEmail: EMAIL,
      password: PASSWORD, termsAccepted: true,
    });
    expect(res.status).toBe(201);
    expect(res.data.account.email_confirmed).toBe(false);
  });

  test('2. Confirm email', async () => {
    // Wait for email delivery
    await new Promise((r) => setTimeout(r, 500));
    const msgs = await mailpitGet('/api/v1/messages?limit=20');
    const myMsg = msgs.messages.find((m) => m.To[0].Address === EMAIL);
    expect(myMsg).toBeTruthy();

    const fullMsg = await mailpitGet('/api/v1/message/' + myMsg.ID);
    const token = fullMsg.Text.match(/token=([a-f0-9]+)/)?.[1];
    expect(token).toBeTruthy();

    const res = await apiCall('POST', '/v1/accounts/confirm-email', { token });
    expect(res.status).toBe(200);
  });

  test('3. Login via GUI form', async () => {
    const res = await apiCall('POST', '/v1/accounts/login', {
      email: EMAIL, password: PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(res.cookie).toBeTruthy();
    cookie = res.cookie;
    me = res.data.account;
    expect(me.name).toBe(NAME);
    expect(me.type).toBe('human');
  });

  test('4. Landing page loads data', async () => {
    const [topics, activity, debates] = await Promise.all([
      apiCall('GET', '/v1/topics?limit=6&lang=en', null, cookie),
      apiCall('GET', '/v1/activity?limit=5', null, cookie),
      apiCall('GET', '/v1/debates?limit=3', null, cookie),
    ]);
    expect(topics.status).toBe(200);
    expect(topics.data.length).toBeGreaterThan(0);
    expect(activity.status).toBe(200);
    expect(debates.status).toBe(200);

    // Save an existing topic for later interactions
    existingTopicId = topics.data[0].id;
  });

  test('5. Create assisted agent via settings', async () => {
    const res = await apiCall('POST', '/v1/accounts/me/agents', {
      name: 'Scholar ' + unique(), autonomous: false,
      description: 'Assisted research agent',
    }, cookie);
    expect(res.status).toBe(201);
    agent = res.data.account;
    expect(agent.autonomous).toBe(false);
    expect(agent.parent_id).toBe(me.id);

    // Verify agent appears in list
    const list = await apiCall('GET', '/v1/accounts/me/agents', null, cookie);
    expect(list.status).toBe(200);
    expect(list.data.agents.some((a) => a.id === agent.id)).toBe(true);
  });

  test('6. Search via GUI (hybrid mode)', async () => {
    const res = await apiCall('GET', '/v1/search?q=knowledge&type=hybrid&limit=5', null, cookie);
    expect(res.status).toBe(200);
    // Hybrid may fallback to text if Ollama is unavailable — both are acceptable
  });

  test('7. View a topic', async () => {
    const res = await apiCall('GET', '/v1/topics/' + existingTopicId, null, cookie);
    expect(res.status).toBe(200);
    expect(res.data.title).toBeTruthy();

    // Load chunks (published)
    const chunks = await apiCall('GET', '/v1/topics/' + existingTopicId + '/chunks?limit=5', null, cookie);
    expect(chunks.status).toBe(200);

    // Load pending
    const pending = await apiCall('GET', '/v1/topics/' + existingTopicId + '/chunks?status=proposed', null, cookie);
    expect(pending.status).toBe(200);

    // Load discussion
    const messages = await apiCall('GET', '/v1/topics/' + existingTopicId + '/messages?limit=5', null, cookie);
    expect(messages.status).toBe(200);

    // Load history
    const history = await apiCall('GET', '/v1/topics/' + existingTopicId + '/history?limit=5', null, cookie);
    expect(history.status).toBe(200);
  });

  test('8. Create article via new-article.html', async () => {
    const res = await apiCall('POST', '/v1/topics/full', {
      title: 'E2E GUI Article ' + unique(),
      lang: 'en', topicType: 'knowledge', sensitivity: 'standard',
      summary: 'E2E test article created through GUI-simulated flow.',
      chunks: [
        { content: 'First chunk: Trust scoring fundamentals for multi-agent systems.' },
        { content: 'Second chunk: The Beta distribution model for contributor reputation.' },
      ],
    }, cookie);
    expect(res.status).toBe(201);
    createdTopicId = res.data.topic.id;
    createdChangesetId = res.data.changesetId;
    expect(res.data.chunks.length).toBe(2);
    expect(res.data.chunks[0].status).toBe('proposed');
  });

  test('9. View new article — proposed_count visible', async () => {
    const res = await apiCall('GET', '/v1/topics/' + createdTopicId, null, cookie);
    expect(res.status).toBe(200);
    expect(res.data.chunk_count).toBe(0); // nothing published yet
    expect(res.data.proposed_count).toBe(2); // our 2 chunks pending

    // Pending chunks visible to author
    const pending = await apiCall('GET', '/v1/topics/' + createdTopicId + '/chunks?status=proposed', null, cookie);
    expect(pending.status).toBe(200);
    expect(pending.data.length).toBe(2);
  });

  test('10. Vote on existing content', async () => {
    // Find a published chunk to vote on
    const chunks = await apiCall('GET', '/v1/topics/' + existingTopicId + '/chunks?limit=1', null, cookie);
    if (chunks.data?.length > 0) {
      const vote = await apiCall('POST', '/v1/votes', {
        targetType: 'chunk', targetId: chunks.data[0].id,
        value: 'up', reasonTag: 'accurate',
      }, cookie);
      // 201 = success, 403 = self-vote (acceptable if seed data), 409 = already voted
      expect([201, 403, 409]).toContain(vote.status);
    }
  });

  test('11. Post discussion message', async () => {
    const res = await apiCall('POST', '/v1/topics/' + existingTopicId + '/messages', {
      type: 'contribution',
      content: 'E2E GUI test discussion message ' + unique(),
    }, cookie);
    expect(res.status).toBe(201);
    expect(res.data.id).toBeTruthy();
  });

  test('12. Subscribe agent to topic', async () => {
    const res = await apiCall('POST', '/v1/subscriptions', {
      type: 'topic', topicId: existingTopicId, forAgentId: agent.id,
    }, cookie);
    expect(res.status).toBe(201);
    expect(res.data.notification_method).toBe('polling'); // assisted = polling
    expect(res.data.account_id).toBe(agent.id); // owned by agent, not parent
  });

  test('13. Check notifications', async () => {
    const res = await apiCall('GET', '/v1/subscriptions/notifications?limit=5', null, cookie);
    expect(res.status).toBe(200);
    // May have notifications from the subscription we just created
  });

  test('14. Review queue accessible', async () => {
    const res = await apiCall('GET', '/v1/reviews/pending?limit=5', null, cookie);
    expect(res.status).toBe(200);
  });

  test('15. My contributions shows changeset', async () => {
    const res = await apiCall('GET', '/v1/accounts/me/contributions?limit=10', null, cookie);
    expect(res.status).toBe(200);
    expect(res.data.length).toBeGreaterThan(0);

    const myChangeset = res.data.find((cs) => cs.id === createdChangesetId);
    expect(myChangeset).toBeTruthy();
    expect(myChangeset.status).toBe('proposed');
    expect(myChangeset.operation_count).toBe(2);
  });

  test('16. Public profile has reputation and tier', async () => {
    const res = await apiCall('GET', '/v1/accounts/' + me.id, null, cookie);
    expect(res.status).toBe(200);
    expect(res.data.account.tier).toBeDefined();
    expect(res.data.account.reputation_contribution).toBeDefined();
  });
});
