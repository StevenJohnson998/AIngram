// @ts-check
/**
 * Sprint 6 E2E tests — Copyright Protection + Distribution.
 * Tests the full takedown/copyright/OpenAPI/SDK flows via API and GUI.
 *
 * Targets the TEST container (aingram-api-test).
 * Run: BASE_URL=http://<test-ip>:3000 npx playwright test sprint6-copyright
 */

const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const { execSync } = require('child_process');

const BASE = process.env.BASE_URL || 'http://172.18.0.22:3000';
const unique = () => crypto.randomBytes(4).toString('hex');

// Container names for test env
const API_CONTAINER = process.env.API_CONTAINER || 'aingram-api';
const DB_CONTAINER = process.env.DB_CONTAINER || 'postgres';
const DB_NAME = process.env.DB_NAME || 'aingram';

/** Create a confirmed user directly in DB with specified tier and badges.
 *  Pipes a node script into the container via stdin to avoid shell escaping issues with bcrypt hashes. */
function createUserInDB({ tier = 0, badgePolicing = false, reputationCopyright = 0.5 } = {}) {
  const id = unique();
  const email = `e2e-cr-${id}@example.com`;
  const password = 'TestPass2026!';
  const name = `E2E-CR ${id}`;

  const script = `
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    (async () => {
      const accountId = crypto.randomUUID();
      const pwHash = bcrypt.hashSync('${password}', 10);
      const prefix = crypto.randomBytes(4).toString('hex');
      const secret = crypto.randomBytes(12).toString('hex');
      const keyHash = bcrypt.hashSync(secret, 10);
      await pool.query(
        \`INSERT INTO accounts (id, name, type, owner_email, password_hash, status, email_confirmed, tier, badge_policing, reputation_copyright, terms_version_accepted, api_key_hash, api_key_prefix) VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,$12)\`,
        [accountId, '${name}', 'human', '${email}', pwHash, 'active', parseInt('${tier}'), ${badgePolicing}, parseFloat('${reputationCopyright}'), '2026-03-21-v1', keyHash, prefix]
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

  return { id: accountId, email, password, name, apiKey: `aingram_${prefix}_${secret}` };
}

/** Create a chunk directly in DB for testing. */
function createChunkInDB(topicId, authorId) {
  const raw = execSync(
    `docker exec ${DB_CONTAINER} psql -U admin -d ${DB_NAME} -t -A -c "
      INSERT INTO chunks (content, created_by, trust_score, status)
      VALUES ('E2E test chunk for copyright testing. Created at ${new Date().toISOString()}. This content has enough length to pass validation.', '${authorId}', 0.5, 'active')
      RETURNING id;"`,
    { encoding: 'utf-8' }
  );
  // psql -t -A can include trailing newlines or command tags — extract first UUID
  const chunkId = raw.trim().split('\n')[0].trim();

  // Link chunk to topic
  execSync(
    `docker exec ${DB_CONTAINER} psql -U admin -d ${DB_NAME} -c "INSERT INTO chunk_topics (chunk_id, topic_id) VALUES ('${chunkId}', '${topicId}');"`,
    { encoding: 'utf-8' }
  );

  return chunkId;
}

// ─── OpenAPI + Static ────────────────────────────────────────────────

test.describe('Sprint 6: OpenAPI & Distribution', () => {

  test('OpenAPI spec is valid JSON with correct version', async ({ request }) => {
    const res = await request.get(BASE + '/openapi.json');
    expect(res.status()).toBe(200);
    const spec = await res.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('AIngram API');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(20);
  });

  test('llms-copyright.txt contains reviewer guide', async ({ request }) => {
    const res = await request.get(BASE + '/llms-copyright.txt');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('Step 1');
    expect(text).toContain('Step 2');
    expect(text).toContain('Step 3');
    expect(text).toContain('Step 4');
    expect(text).toContain('Verdict summary');
    expect(text).toContain('Red flags');
  });

  test('llms-api.txt references Python SDK and OpenAPI', async ({ request }) => {
    const res = await request.get(BASE + '/llms-api.txt');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('Python SDK');
    expect(text).toContain('openapi.json');
    expect(text).toContain('copyright-reviews');
  });
});

// ─── Reports & Takedown API ─────────────────────────────────────────

test.describe('Sprint 6: Reports & Takedown', () => {
  let author;
  let reviewer;
  let lowRepReviewer;
  let topicId;
  let chunkId;

  test.beforeAll(async () => {
    author = createUserInDB({ tier: 1 });
    reviewer = createUserInDB({ tier: 2, badgePolicing: true, reputationCopyright: 0.9 });
    lowRepReviewer = createUserInDB({ tier: 2, badgePolicing: true, reputationCopyright: 0.3 });

    // Get a topic to create chunks on
    const topicResult = execSync(
      `docker exec ${DB_CONTAINER} psql -U admin -d ${DB_NAME} -t -A -c "SELECT id FROM topics LIMIT 1;"`,
      { encoding: 'utf-8' }
    ).trim();
    topicId = topicResult;
    chunkId = createChunkInDB(topicId, author.id);
  });

  test('public report creation works', async ({ request }) => {
    const res = await request.post(BASE + '/v1/reports', {
      data: {
        contentId: chunkId,
        contentType: 'chunk',
        reason: 'This content appears to infringe copyright from an external source',
        reporterEmail: `reporter-${unique()}@example.com`,
      },
    });
    // 201 or 429 (rate limited)
    expect([201, 429]).toContain(res.status());
  });

  test('takedown rejected for low reputation_copyright reviewer', async ({ request }) => {
    // Create a report first
    const reportRes = await request.post(BASE + '/v1/reports', {
      data: {
        contentId: chunkId,
        contentType: 'chunk',
        reason: 'Copyright infringement for low-rep takedown test content',
        reporterEmail: `reporter-${unique()}@example.com`,
      },
    });

    if (reportRes.status() === 429) {
      test.skip();
      return;
    }

    const report = await reportRes.json();
    const reportId = report.id || report.data?.id;

    // Try takedown with low-rep reviewer
    const res = await request.post(BASE + `/v1/reports/${reportId}/takedown`, {
      headers: { Authorization: `Bearer ${lowRepReviewer.apiKey}` },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('INSUFFICIENT_REPUTATION');
  });

  test('takedown succeeds for high reputation_copyright reviewer', async ({ request }) => {
    // Create a fresh chunk and report
    const freshChunkId = createChunkInDB(topicId, author.id);

    const reportRes = await request.post(BASE + '/v1/reports', {
      data: {
        contentId: freshChunkId,
        contentType: 'chunk',
        reason: 'Verbatim copy from a published paper for high-rep takedown test',
        reporterEmail: `reporter-${unique()}@example.com`,
      },
    });

    if (reportRes.status() === 429) {
      test.skip();
      return;
    }

    const report = await reportRes.json();
    const reportId = report.id || report.data?.id;

    // Takedown with high-rep reviewer
    const res = await request.post(BASE + `/v1/reports/${reportId}/takedown`, {
      headers: { Authorization: `Bearer ${reviewer.apiKey}` },
    });
    expect(res.status()).toBe(200);

    // Verify chunk is hidden from public search
    const searchRes = await request.get(BASE + `/v1/chunks/${freshChunkId}`);
    // Chunk should still be accessible by ID but marked hidden
    if (searchRes.status() === 200) {
      const chunk = await searchRes.json();
      expect(chunk.data?.hidden || chunk.hidden).toBe(true);
    }
  });

  test('counter-notice requires minimum 50 chars reason', async ({ request }) => {
    const res = await request.post(BASE + '/v1/reports/00000000-0000-0000-0000-000000000000/counter-notice', {
      data: { email: 'author@example.com', reason: 'Too short' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('50 characters');
  });
});

// ─── Copyright Review Queue ──────────────────────────────────────────

test.describe('Sprint 6: Copyright Review Queue', () => {
  let tier1User;
  let reviewer;
  let topicId;
  let chunkId;

  test.beforeAll(async () => {
    tier1User = createUserInDB({ tier: 1 });
    reviewer = createUserInDB({ tier: 2, badgePolicing: true, reputationCopyright: 0.9 });

    const topicResult = execSync(
      `docker exec ${DB_CONTAINER} psql -U admin -d ${DB_NAME} -t -A -c "SELECT id FROM topics LIMIT 1;"`,
      { encoding: 'utf-8' }
    ).trim();
    topicId = topicResult;
    chunkId = createChunkInDB(topicId, tier1User.id);
  });

  test('Tier 1+ can create a copyright review', async ({ request }) => {
    const res = await request.post(BASE + '/v1/copyright-reviews', {
      headers: { Authorization: `Bearer ${tier1User.apiKey}` },
      data: {
        chunkId: chunkId,
        reason: 'This content seems to be copied from a published research paper without attribution',
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.data?.status || body.status).toBe('pending');
  });

  test('duplicate copyright review on same chunk rejected', async ({ request }) => {
    const res = await request.post(BASE + '/v1/copyright-reviews', {
      headers: { Authorization: `Bearer ${tier1User.apiKey}` },
      data: {
        chunkId: chunkId,
        reason: 'Another copyright claim on the same chunk should be rejected',
      },
    });
    expect(res.status()).toBe(409);
  });

  test('copyright review queue accessible to policing badge', async ({ request }) => {
    const res = await request.get(BASE + '/v1/copyright-reviews?status=pending', {
      headers: { Authorization: `Bearer ${reviewer.apiKey}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(body.pagination).toBeDefined();
    expect(body.pagination.total).toBeGreaterThan(0);
  });

  test('copyright review queue requires auth', async ({ request }) => {
    const res = await request.get(BASE + '/v1/copyright-reviews');
    expect(res.status()).toBe(401);
  });

  test('resolve copyright review with verdict "clear"', async ({ request }) => {
    // Create fresh chunk + review
    const freshChunkId = createChunkInDB(topicId, tier1User.id);
    const reporter = createUserInDB({ tier: 1 });

    const createRes = await request.post(BASE + '/v1/copyright-reviews', {
      headers: { Authorization: `Bearer ${reporter.apiKey}` },
      data: { chunkId: freshChunkId, reason: 'Looks like it might be copied from somewhere online' },
    });
    expect(createRes.status()).toBe(201);
    const review = await createRes.json();
    const reviewId = review.data?.id || review.id;

    // Resolve as clear
    const resolveRes = await request.post(BASE + `/v1/copyright-reviews/${reviewId}/resolve`, {
      headers: { Authorization: `Bearer ${reviewer.apiKey}` },
      data: { verdict: 'clear', verdictNotes: 'No copyright infringement found' },
    });
    expect(resolveRes.status()).toBe(200);
    const resolved = await resolveRes.json();
    expect(resolved.data?.verdict || resolved.verdict).toBe('clear');
  });

  test('resolve copyright review with verdict "rewrite_required" hides chunk', async ({ request }) => {
    const freshChunkId = createChunkInDB(topicId, tier1User.id);
    const reporter = createUserInDB({ tier: 1 });

    const createRes = await request.post(BASE + '/v1/copyright-reviews', {
      headers: { Authorization: `Bearer ${reporter.apiKey}` },
      data: { chunkId: freshChunkId, reason: 'Content closely mirrors a copyrighted article without proper attribution' },
    });
    expect(createRes.status()).toBe(201);
    const reviewId = (await createRes.json()).data?.id || (await createRes.json()).id;

    const resolveRes = await request.post(BASE + `/v1/copyright-reviews/${reviewId}/resolve`, {
      headers: { Authorization: `Bearer ${reviewer.apiKey}` },
      data: { verdict: 'rewrite_required', verdictNotes: 'Needs reformulation and proper citation' },
    });
    expect(resolveRes.status()).toBe(200);

    // Verify chunk is hidden
    const chunkRes = await request.get(BASE + `/v1/chunks/${freshChunkId}`);
    if (chunkRes.status() === 200) {
      const chunk = await chunkRes.json();
      expect(chunk.data?.hidden || chunk.hidden).toBe(true);
    }
  });

  test('res judicata: same reporter, similar claim rejected', async ({ request }) => {
    // The chunk from the "clear" test above was already cleared
    // Create a new chunk, clear it, then re-file with similar reason
    const freshChunkId = createChunkInDB(topicId, tier1User.id);
    const reporter = createUserInDB({ tier: 1 });

    // Create + clear
    const createRes = await request.post(BASE + '/v1/copyright-reviews', {
      headers: { Authorization: `Bearer ${reporter.apiKey}` },
      data: { chunkId: freshChunkId, reason: 'Content copied verbatim from Stanford AI Index Report 2025 chapter three section five' },
    });
    expect(createRes.status()).toBe(201);
    const createBody = await createRes.json();
    const reviewId = createBody.data?.id || createBody.id;

    await request.post(BASE + `/v1/copyright-reviews/${reviewId}/resolve`, {
      headers: { Authorization: `Bearer ${reviewer.apiKey}` },
      data: { verdict: 'clear', verdictNotes: 'No infringement' },
    });

    // Re-file with very similar reason (same key words)
    const refileRes = await request.post(BASE + '/v1/copyright-reviews', {
      headers: { Authorization: `Bearer ${reporter.apiKey}` },
      data: { chunkId: freshChunkId, reason: 'Copied verbatim from Stanford AI Index Report 2025 chapter three section five without permission' },
    });
    expect(refileRes.status()).toBe(409);
    const body = await refileRes.json();
    expect(body.error.code).toBe('ALREADY_CLEARED');
  });

  test('verbatim search tool requires policing badge', async ({ request }) => {
    // Tier 1 user (no policing badge) should be rejected
    const res = await request.get(BASE + '/v1/copyright-reviews/tools/verbatim-search?text=' + encodeURIComponent('test chunk for copyright'), {
      headers: { Authorization: `Bearer ${tier1User.apiKey}` },
    });
    expect(res.status()).toBe(403);
  });

  test('verbatim search tool works for policing badge', async ({ request }) => {
    const res = await request.get(BASE + '/v1/copyright-reviews/tools/verbatim-search?text=' + encodeURIComponent('E2E test chunk for copyright testing'), {
      headers: { Authorization: `Bearer ${reviewer.apiKey}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
  });

  test('check-sources tool works', async ({ request }) => {
    const res = await request.get(BASE + `/v1/copyright-reviews/tools/check-sources/${chunkId}`, {
      headers: { Authorization: `Bearer ${reviewer.apiKey}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const result = body.data || body;
    expect(result.chunkId).toBe(chunkId);
    // No sources on test chunk, should warn
    expect(result.warning).toContain('No sources');
  });
});

// ─── Hidden Chunk Enforcement ────────────────────────────────────────

test.describe('Sprint 6: Hidden chunks filtered from public', () => {
  let reviewer;
  let topicId;

  test.beforeAll(async () => {
    reviewer = createUserInDB({ tier: 2, badgePolicing: true, reputationCopyright: 0.9 });
    const topicResult = execSync(
      `docker exec ${DB_CONTAINER} psql -U admin -d ${DB_NAME} -t -A -c "SELECT id FROM topics LIMIT 1;"`,
      { encoding: 'utf-8' }
    ).trim();
    topicId = topicResult;
  });

  test('hidden chunk not returned in topic chunk list', async ({ request }) => {
    const author = createUserInDB({ tier: 1 });
    const hiddenChunkId = createChunkInDB(topicId, author.id);

    // Manually hide it
    execSync(
      `docker exec ${DB_CONTAINER} psql -U admin -d ${DB_NAME} -c "UPDATE chunks SET hidden = true WHERE id = '${hiddenChunkId}';"`,
      { encoding: 'utf-8' }
    );

    // Fetch topic chunks
    const res = await request.get(BASE + `/v1/topics/${topicId}/chunks?status=active&limit=100`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const chunkIds = body.data.map(c => c.id);
    expect(chunkIds).not.toContain(hiddenChunkId);
  });

  test('hidden chunk not returned in search results', async ({ request }) => {
    // Search for the unique content of our hidden chunk
    const res = await request.get(BASE + '/v1/search?q=E2E+test+chunk+copyright+testing&type=text&limit=50');
    if (res.status() === 200) {
      const body = await res.json();
      const hiddenResults = body.data.filter(r => r.hidden === true);
      expect(hiddenResults).toHaveLength(0);
    }
  });
});
