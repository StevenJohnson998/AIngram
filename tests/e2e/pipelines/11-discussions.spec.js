// @ts-check
/**
 * 11 — Discussions & Messages
 *
 * Verifies message creation (level-1, level-2), replies, verbosity filtering.
 */

const { test, expect } = require('@playwright/test');
const {
  BASE, apiAuth, createUserInDB, createTopicInDB, unique,
} = require('./helpers');

test.describe('Discussions & Messages', () => {
  let author, replier, topic;
  let messageId;

  test.beforeAll(async () => {
    author = createUserInDB({ prefix: 'e2e-disc-auth' });
    replier = createUserInDB({ prefix: 'e2e-disc-repl' });
    topic = createTopicInDB(author.id);
  });

  test('POST level-1 contribution message', async ({ request }) => {
    const res = await request.post(`${BASE}/v1/topics/${topic.id}/messages`, {
      headers: apiAuth(author),
      data: {
        content: `Level 1 contribution for discussion testing ${unique()}`,
        type: 'contribution',
      },
    });

    expect(res.status()).toBe(201);
    const json = await res.json();
    const msg = json.data || json;
    messageId = msg.id;
    expect(msg.level).toBe(1);
  });

  test('POST level-2 review reply', async ({ request }) => {
    if (!messageId) { test.skip(); return; }

    const res = await request.post(`${BASE}/v1/topics/${topic.id}/messages`, {
      headers: apiAuth(replier),
      data: {
        content: `Level 2 moderation vote reply for discussion testing with enough length to pass fifty character minimum ${unique()}`,
        type: 'moderation_vote',
        parentId: messageId,
      },
    });

    expect(res.status()).toBe(201);
    const json = await res.json();
    const msg = json.data || json;
    expect(msg.level).toBe(2);
  });

  test('GET messages with verbosity filter', async ({ request }) => {
    const res = await request.get(`${BASE}/v1/topics/${topic.id}/messages?verbosity=low`);

    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.data).toBeDefined();
    expect(Array.isArray(json.data)).toBe(true);
  });

  test('GET /messages/:id/replies returns thread', async ({ request }) => {
    if (!messageId) { test.skip(); return; }

    const res = await request.get(`${BASE}/v1/messages/${messageId}/replies`);

    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.data).toBeDefined();
    expect(json.data.length).toBeGreaterThanOrEqual(1);
  });
});
