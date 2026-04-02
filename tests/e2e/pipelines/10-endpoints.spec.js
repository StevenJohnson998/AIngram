// @ts-check
/**
 * 10 — New GET Endpoints (Sprint 12)
 *
 * Validates the new read endpoints added during Sprint 12 wiring.
 */

const { test, expect } = require('@playwright/test');
const {
  BASE, apiAuth, createUserInDB, createTopicInDB, createChunkInDB,
  createMessageInDB, createFlagInDB, unique,
} = require('./helpers');

test.describe('Sprint 12 GET Endpoints', () => {
  let user, policer, topic, chunkId, messageId;

  test.beforeAll(async () => {
    user = createUserInDB({ prefix: 'e2e-ep' });
    policer = createUserInDB({ prefix: 'e2e-ep-pol', tier: 2, badgePolicing: true });
    topic = createTopicInDB(user.id);
    chunkId = createChunkInDB(topic.id, user.id,
      `Endpoint test chunk for vote summary and flags ${unique()}`);
    messageId = createMessageInDB(topic.id, user.id, {
      content: `Endpoint test message ${unique()}`,
    });
  });

  test('GET /votes/summary returns correct shape', async ({ request }) => {
    // Cast a vote first so summary has data
    await request.post(`${BASE}/v1/votes`, {
      headers: apiAuth(policer),
      data: { target_type: 'chunk', target_id: chunkId, value: 'up', reason_tag: 'accurate' },
    });

    const res = await request.get(
      `${BASE}/v1/votes/summary?target_type=chunk&target_id=${chunkId}`
    );

    expect(res.status()).toBe(200);
    const json = await res.json();
    const summary = json.data || json;
    expect(summary.upCount).toBeGreaterThanOrEqual(1);
    expect(summary.downCount).toBeGreaterThanOrEqual(0);
    expect(typeof summary.upWeight).toBe('number');
    expect(typeof summary.downWeight).toBe('number');
    expect(summary.total).toBeGreaterThanOrEqual(1);
  });

  test('GET /flags/target returns flags for a target', async ({ request }) => {
    // Create a flag on the chunk
    createFlagInDB(policer.id, 'chunk', chunkId, 'E2E endpoint test flag');

    const res = await request.get(
      `${BASE}/v1/flags/target?target_type=chunk&target_id=${chunkId}`,
      { headers: apiAuth(policer) }
    );

    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.data).toBeDefined();
    expect(json.data.length).toBeGreaterThanOrEqual(1);
  });

  test('GET /accounts/:id/flags/count returns count', async ({ request }) => {
    const res = await request.get(
      `${BASE}/v1/accounts/${user.id}/flags/count`,
      { headers: apiAuth(user) }
    );

    expect(res.status()).toBe(200);
    const json = await res.json();
    const result = json.data || json;
    expect(typeof result.count).toBe('number');
  });

  test('GET /accounts/:id/messages returns paginated messages', async ({ request }) => {
    const res = await request.get(
      `${BASE}/v1/accounts/${user.id}/messages`,
    );

    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.data).toBeDefined();
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.pagination).toBeDefined();
    expect(json.pagination.total).toBeGreaterThanOrEqual(1);
  });

  test('GET /accounts/:id/subscription-tier returns tier info', async ({ request }) => {
    const res = await request.get(
      `${BASE}/v1/accounts/${user.id}/subscription-tier`,
      { headers: apiAuth(user) }
    );

    expect(res.status()).toBe(200);
    const json = await res.json();
    const tier = json.data || json;
    expect(tier).toHaveProperty('tier');
    expect(tier).toHaveProperty('limit');
  });
});
