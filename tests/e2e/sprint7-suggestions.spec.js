// @ts-check
/**
 * Sprint 7 E2E tests — Suggestions + Copyright Analytics.
 * Tests suggestion CRUD, escalation, voting tier gates, analytics endpoints.
 *
 * Targets the TEST container (aingram-api-test).
 * Run: npx playwright test sprint7-suggestions
 */

const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const { execSync } = require('child_process');

const BASE = process.env.BASE_URL || 'http://172.18.0.19:3000';
const unique = () => crypto.randomBytes(4).toString('hex');

const API_CONTAINER = process.env.API_CONTAINER || 'aingram-api-test';

/** Create a confirmed user in DB with specified tier and badges. */
function createUserInDB({ tier = 0, badgePolicing = false } = {}) {
  const id = unique();
  const email = `e2e-s7-${id}@example.com`;
  const name = `E2E-S7 ${id}`;

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
        \`INSERT INTO accounts (id, name, type, owner_email, password_hash, status, email_confirmed, tier, badge_policing, first_contribution_at, terms_version_accepted, api_key_hash, api_key_prefix, reputation_contribution) VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,now(),$9,$10,$11,0.8)\`,
        [accountId, '${name}', 'human', '${email}', pwHash, 'active', parseInt('${tier}'), ${badgePolicing}, '2026-03-21-v1', keyHash, prefix]
      );
      console.log(JSON.stringify({ id: accountId, secret, prefix }));
      await pool.end();
    })();
  `;

  const result = execSync(
    `docker exec -i ${API_CONTAINER} node`,
    { input: script, encoding: 'utf-8', timeout: 10000 }
  ).trim();
  const { id: accountId, secret, prefix } = JSON.parse(result);

  return { id: accountId, email, name, apiKey: `aingram_${prefix}_${secret}` };
}

/** Get or create a topic for testing. */
function getOrCreateTopic() {
  const script = `
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    (async () => {
      const { rows } = await pool.query("SELECT id FROM topics LIMIT 1");
      if (rows.length > 0) { console.log(rows[0].id); }
      else {
        const crypto = require('crypto');
        const id = crypto.randomUUID();
        await pool.query("INSERT INTO topics (id, title, slug, lang, status) VALUES ($1, 'Test Topic S7', 'test-topic-s7', 'en', 'active')", [id]);
        console.log(id);
      }
      await pool.end();
    })();
  `;
  return execSync(`docker exec -i ${API_CONTAINER} node`, { input: script, encoding: 'utf-8', timeout: 10000 }).trim();
}

let topicId;

test.beforeAll(() => {
  topicId = getOrCreateTopic();
});

test.describe('Sprint 7: Suggestions', () => {
  test('any tier can create a suggestion', async ({ request }) => {
    const user = createUserInDB({ tier: 0 });
    const res = await request.post(`${BASE}/v1/suggestions`, {
      headers: { Authorization: `Bearer ${user.apiKey}`, 'Content-Type': 'application/json' },
      data: {
        content: 'We should add a cooldown period after disputes to prevent retaliation.',
        topicId,
        suggestionCategory: 'governance',
        rationale: 'Too many retaliatory disputes observed.',
        title: 'Dispute cooldown ' + unique(),
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.data.chunk_type).toBe('suggestion');
    expect(body.data.suggestion_category).toBe('governance');
    expect(body.data.status).toBe('proposed');
  });

  test('rejects suggestion with short content', async ({ request }) => {
    const user = createUserInDB({ tier: 0 });
    const res = await request.post(`${BASE}/v1/suggestions`, {
      headers: { Authorization: `Bearer ${user.apiKey}`, 'Content-Type': 'application/json' },
      data: { content: 'Too short', topicId, suggestionCategory: 'governance' },
    });
    expect(res.status()).toBe(400);
  });

  test('rejects invalid suggestion category', async ({ request }) => {
    const user = createUserInDB({ tier: 0 });
    const res = await request.post(`${BASE}/v1/suggestions`, {
      headers: { Authorization: `Bearer ${user.apiKey}`, 'Content-Type': 'application/json' },
      data: { content: 'A valid proposal with enough characters for testing.', topicId, suggestionCategory: 'invalid_cat' },
    });
    expect(res.status()).toBe(400);
  });

  test('list suggestions filtered by status', async ({ request }) => {
    const res = await request.get(`${BASE}/v1/suggestions?status=proposed`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(body.pagination).toBeDefined();
  });

  test('list suggestions filtered by category', async ({ request }) => {
    const res = await request.get(`${BASE}/v1/suggestions?status=proposed&category=governance`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    for (const s of body.data) {
      expect(s.suggestion_category).toBe('governance');
    }
  });

  test('author can withdraw a proposed suggestion', async ({ request }) => {
    const user = createUserInDB({ tier: 0 });
    // Create
    const createRes = await request.post(`${BASE}/v1/suggestions`, {
      headers: { Authorization: `Bearer ${user.apiKey}`, 'Content-Type': 'application/json' },
      data: { content: 'A suggestion to be withdrawn for testing purposes.', topicId, suggestionCategory: 'technical', title: 'Withdraw test' },
    });
    const suggestion = (await createRes.json()).data;

    // Withdraw
    const delRes = await request.delete(`${BASE}/v1/suggestions/${suggestion.id}`, {
      headers: { Authorization: `Bearer ${user.apiKey}` },
    });
    expect(delRes.status()).toBe(200);
    const body = await delRes.json();
    expect(body.data.status).toBe('retracted');
  });

  test('non-author cannot withdraw a suggestion', async ({ request }) => {
    const author = createUserInDB({ tier: 0 });
    const other = createUserInDB({ tier: 0 });

    const createRes = await request.post(`${BASE}/v1/suggestions`, {
      headers: { Authorization: `Bearer ${author.apiKey}`, 'Content-Type': 'application/json' },
      data: { content: 'A suggestion that someone else tries to withdraw.', topicId, suggestionCategory: 'ui_ux' },
    });
    const suggestion = (await createRes.json()).data;

    const delRes = await request.delete(`${BASE}/v1/suggestions/${suggestion.id}`, {
      headers: { Authorization: `Bearer ${other.apiKey}` },
    });
    expect(delRes.status()).toBe(403);
  });

  test('T2 can escalate a suggestion to formal vote', async ({ request }) => {
    const author = createUserInDB({ tier: 0 });
    const t2user = createUserInDB({ tier: 2 });

    const createRes = await request.post(`${BASE}/v1/suggestions`, {
      headers: { Authorization: `Bearer ${author.apiKey}`, 'Content-Type': 'application/json' },
      data: { content: 'A suggestion to escalate to formal vote for Sprint 7 testing.', topicId, suggestionCategory: 'new_feature', title: 'Escalation test' },
    });
    const suggestion = (await createRes.json()).data;

    // Escalate
    const escRes = await request.post(`${BASE}/v1/suggestions/${suggestion.id}/escalate`, {
      headers: { Authorization: `Bearer ${t2user.apiKey}` },
    });
    expect(escRes.status()).toBe(200);
    const body = await escRes.json();
    expect(body.data.status).toBe('under_review');
  });

  test('T1 cannot escalate a suggestion', async ({ request }) => {
    const author = createUserInDB({ tier: 0 });
    const t1user = createUserInDB({ tier: 1 });

    const createRes = await request.post(`${BASE}/v1/suggestions`, {
      headers: { Authorization: `Bearer ${author.apiKey}`, 'Content-Type': 'application/json' },
      data: { content: 'A suggestion that T1 tries to escalate but should fail.', topicId, suggestionCategory: 'documentation' },
    });
    const suggestion = (await createRes.json()).data;

    const escRes = await request.post(`${BASE}/v1/suggestions/${suggestion.id}/escalate`, {
      headers: { Authorization: `Bearer ${t1user.apiKey}` },
    });
    expect(escRes.status()).toBe(403);
  });

  test('suggestions do not fast-track merge', async ({ request }) => {
    // Create a suggestion and verify it stays proposed (not auto-merged)
    const user = createUserInDB({ tier: 0 });
    const createRes = await request.post(`${BASE}/v1/suggestions`, {
      headers: { Authorization: `Bearer ${user.apiKey}`, 'Content-Type': 'application/json' },
      data: { content: 'A suggestion that should NOT be fast-tracked to active.', topicId, suggestionCategory: 'governance', title: 'No fast-track' },
    });
    const suggestion = (await createRes.json()).data;
    expect(suggestion.status).toBe('proposed');
    // No auto-merge expected — verify it's still proposed
    const getRes = await request.get(`${BASE}/v1/suggestions/${suggestion.id}`);
    const body = await getRes.json();
    expect(body.data.status).toBe('proposed');
  });
});

test.describe('Sprint 7: Suggestion Vote Tier Gate', () => {
  test('T1 cannot commit vote on suggestion', async ({ request }) => {
    const author = createUserInDB({ tier: 0 });
    const t2sponsor = createUserInDB({ tier: 2 });
    const t1voter = createUserInDB({ tier: 1 });

    // Create + escalate
    const createRes = await request.post(`${BASE}/v1/suggestions`, {
      headers: { Authorization: `Bearer ${author.apiKey}`, 'Content-Type': 'application/json' },
      data: { content: 'A suggestion for tier gate testing, should require T2 to vote.', topicId, suggestionCategory: 'governance' },
    });
    const suggestion = (await createRes.json()).data;

    await request.post(`${BASE}/v1/suggestions/${suggestion.id}/escalate`, {
      headers: { Authorization: `Bearer ${t2sponsor.apiKey}` },
    });

    // T1 tries to commit vote
    const commitHash = crypto.createHash('sha256').update('1accurate' + 'salt123').digest('hex');
    const voteRes = await request.post(`${BASE}/v1/votes/formal/commit`, {
      headers: { Authorization: `Bearer ${t1voter.apiKey}`, 'Content-Type': 'application/json' },
      data: { chunk_id: suggestion.id, commit_hash: commitHash },
    });
    expect(voteRes.status()).toBe(403);
  });
});

test.describe('Sprint 7: Copyright Analytics', () => {
  test('analytics endpoint requires policing badge', async ({ request }) => {
    const user = createUserInDB({ tier: 2, badgePolicing: false });
    const res = await request.get(`${BASE}/v1/analytics/copyright`, {
      headers: { Authorization: `Bearer ${user.apiKey}` },
    });
    expect(res.status()).toBe(403);
  });

  test('policing badge user can access analytics', async ({ request }) => {
    const user = createUserInDB({ tier: 2, badgePolicing: true });
    const res = await request.get(`${BASE}/v1/analytics/copyright`, {
      headers: { Authorization: `Bearer ${user.apiKey}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.total_reviews).toBeDefined();
  });

  test('reporter stats endpoint works', async ({ request }) => {
    const user = createUserInDB({ tier: 2, badgePolicing: true });
    const res = await request.get(`${BASE}/v1/analytics/copyright/reporters`, {
      headers: { Authorization: `Bearer ${user.apiKey}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(body.pagination).toBeDefined();
  });

  test('timeline endpoint works', async ({ request }) => {
    const user = createUserInDB({ tier: 2, badgePolicing: true });
    const res = await request.get(`${BASE}/v1/analytics/copyright/timeline?days=7`, {
      headers: { Authorization: `Bearer ${user.apiKey}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
  });
});

test.describe('Sprint 7: Suggestions GUI', () => {
  test('suggestions page loads', async ({ page }) => {
    await page.goto(`${BASE}/suggestions.html`);
    await expect(page.locator('h1')).toContainText('Improvement Suggestions');
  });
});

test.describe('Sprint 7: Dynamic Directives', () => {
  test('dynamic directive endpoint returns text', async ({ request }) => {
    const res = await request.get(`${BASE}/llms-copyright-dynamic.txt`);
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('AIngram');
    expect(text).toContain('Copyright');
  });
});
