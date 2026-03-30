// @ts-check
/**
 * Sprint 8 E2E tests — Hot Topics, suggest_improvement MCP tool, source tools.
 *
 * Targets the TEST container (aingram-api-test).
 * Run: npx playwright test sprint8-features
 */

const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const { execSync } = require('child_process');

const BASE = process.env.BASE_URL || 'http://172.18.0.19:3000';
const GUI_BASE = BASE;
const unique = () => crypto.randomBytes(4).toString('hex');
const API_CONTAINER = process.env.API_CONTAINER || 'aingram-api-test';

/** Create a confirmed user in DB with API key. */
function createUserInDB({ tier = 0 } = {}) {
  const id = unique();
  const email = `e2e-s8-${id}@example.com`;
  const name = `E2E-S8 ${id}`;

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
        \`INSERT INTO accounts (id, name, type, owner_email, password_hash, status, email_confirmed, tier, first_contribution_at, terms_version_accepted, api_key_hash, api_key_prefix, reputation_contribution) VALUES ($1,$2,$3,$4,$5,$6,true,$7,now(),$8,$9,$10,0.5)\`,
        [accountId, '${name}', 'human', '${email}', pwHash, 'active', parseInt('${tier}'), '2026-03-21-v1', keyHash, prefix]
      );
      console.log(JSON.stringify({ id: accountId, secret, prefix, apiKey: \`aingram_\${prefix}_\${secret}\` }));
      await pool.end();
    })();
  `;
  const raw = execSync(
    `docker exec -i ${API_CONTAINER} node`,
    { input: script, encoding: 'utf-8', timeout: 10000 }
  ).trim();
  return JSON.parse(raw);
}

// ── Hot Topics GUI ─────────────────────────────────────────────────

test.describe('Hot Topics page', () => {
  test('loads and displays topic list', async ({ page }) => {
    await page.goto(`${GUI_BASE}/hot-topics.html`);
    await expect(page.locator('h1')).toContainText('Hot Topics');
    // Wait for loading to disappear, then check content rendered
    await expect(page.locator('#hot-loading')).toBeHidden({ timeout: 10000 });
    // Either table has rows or empty message is shown
    const tableVisible = await page.locator('#hot-table').isVisible();
    const emptyVisible = await page.locator('#hot-empty').isVisible();
    expect(tableVisible || emptyVisible).toBe(true);
  });

  test('nav link is present on all pages', async ({ page }) => {
    for (const path of ['/', '/search.html', '/review-queue.html', '/suggestions.html']) {
      await page.goto(`${GUI_BASE}${path}`);
      const link = page.locator('a[href="./hot-topics.html"]');
      await expect(link).toBeVisible();
    }
  });
});

// ── Hot Topics API ─────────────────────────────────────────────────

test.describe('Hot Topics API', () => {
  test('GET /analytics/hot-topics returns data', async ({ request }) => {
    const res = await request.get(`${BASE}/v1/analytics/hot-topics`);
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty('data');
    expect(json).toHaveProperty('period_days', 7);
    expect(Array.isArray(json.data)).toBe(true);
  });

  test('respects days parameter', async ({ request }) => {
    const res = await request.get(`${BASE}/v1/analytics/hot-topics?days=30`);
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.period_days).toBe(30);
  });
});

// ── Suggestion via API ─────────────────────────────────────────────

test.describe('Suggestion creation via API', () => {
  test('POST /suggestions creates a suggestion chunk', async ({ request }) => {
    const user = createUserInDB({ tier: 0 });

    // First get a topic ID
    const topicsRes = await request.get(`${BASE}/v1/topics?limit=1`);
    expect(topicsRes.status()).toBe(200);
    const topics = await topicsRes.json();
    if (!topics.data || topics.data.length === 0) {
      test.skip();
      return;
    }
    const topicId = topics.data[0].id;

    const res = await request.post(`${BASE}/v1/suggestions`, {
      headers: { Authorization: `Bearer ${user.apiKey}` },
      data: {
        topicId,
        content: `E2E test suggestion content ${unique()} — should be at least twenty characters.`,
        suggestionCategory: 'technical',
        title: `E2E Suggestion ${unique()}`,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    const suggestion = body.data || body;
    expect(suggestion.chunk_type).toBe('suggestion');
    expect(suggestion.status).toBe('proposed');
    expect(suggestion.suggestion_category).toBe('technical');
  });
});

// ── Source tools (check-sources) ───────────────────────────────────

test.describe('Copyright review source tools', () => {
  test('check-sources returns enriched source data', async ({ request }) => {
    const user = createUserInDB({ tier: 1 });

    // We need a policing badge user — upgrade via DB
    const badgeScript = `
      const { Pool } = require('pg');
      const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
      pool.query('UPDATE accounts SET badge_policing = true WHERE id = $1', ['${user.id}']).then(() => pool.end());
    `;
    execSync(`docker exec -i ${API_CONTAINER} node`, { input: badgeScript, encoding: 'utf-8', timeout: 10000 });

    // Find a chunk with sources
    const topicsRes = await request.get(`${BASE}/v1/topics?limit=1`);
    const topics = await topicsRes.json();
    if (!topics.data?.length) { test.skip(); return; }

    const topicRes = await request.get(`${BASE}/v1/topics/${topics.data[0].id}`);
    const topicBody = await topicRes.json();
    const topic = topicBody.data || topicBody;
    if (!topic.chunks?.length) { test.skip(); return; }

    const chunkId = topic.chunks[0].id;

    const res = await request.get(`${BASE}/v1/copyright-reviews/tools/check-sources/${chunkId}`, {
      headers: { Authorization: `Bearer ${user.apiKey}` },
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('chunkId', chunkId);
    expect(data).toHaveProperty('sources');
    expect(Array.isArray(data.sources)).toBe(true);
  });
});

// ── Topic chunk pagination ─────────────────────────────────────────

test.describe('Topic chunk pagination', () => {
  test('GET /topics/:id returns pagination metadata', async ({ request }) => {
    const topicsRes = await request.get(`${BASE}/v1/topics?limit=1`);
    const topics = await topicsRes.json();
    if (!topics.data?.length) { test.skip(); return; }

    const res = await request.get(`${BASE}/v1/topics/${topics.data[0].id}?limit=5`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const topic = body.data || body;
    expect(topic).toHaveProperty('chunks_pagination');
    expect(topic.chunks_pagination).toHaveProperty('total');
    expect(topic.chunks_pagination).toHaveProperty('page', 1);
    expect(topic.chunks_pagination).toHaveProperty('limit', 5);
  });

  test('page parameter offsets results', async ({ request }) => {
    const topicsRes = await request.get(`${BASE}/v1/topics?limit=1`);
    const topics = await topicsRes.json();
    if (!topics.data?.length) { test.skip(); return; }
    const topicId = topics.data[0].id;

    const body1 = await (await request.get(`${BASE}/v1/topics/${topicId}?limit=2&page=1`)).json();
    const body2 = await (await request.get(`${BASE}/v1/topics/${topicId}?limit=2&page=2`)).json();
    const page1 = body1.data || body1;
    const page2 = body2.data || body2;

    if (page1.chunks_pagination.total <= 2) { test.skip(); return; }

    expect(page1.chunks[0].id).not.toBe(page2.chunks[0].id);
  });
});
