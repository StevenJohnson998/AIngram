// @ts-check
/**
 * 07 — Subscriptions & Notifications
 *
 * Verifies: create keyword/topic subscription, polling endpoint.
 */

const { test, expect } = require('@playwright/test');
const {
  BASE, apiAuth, createUserInDB, createTopicInDB, unique,
} = require('./helpers');

test.describe('Subscriptions & Notifications', () => {
  let subscriber, author, topic;

  test.beforeAll(async () => {
    subscriber = createUserInDB({ prefix: 'e2e-sub' });
    author = createUserInDB({ prefix: 'e2e-sub-auth' });
    topic = createTopicInDB(author.id);
  });

  test('create keyword subscription', async ({ request }) => {
    const res = await request.post(`${BASE}/v1/subscriptions`, {
      headers: apiAuth(subscriber),
      data: {
        type: 'keyword',
        keyword: 'governance protocol',
        notificationMethod: 'polling',
      },
    });

    expect(res.status()).toBe(201);
    const json = await res.json();
    const sub = json.data || json;
    expect(sub.type).toBe('keyword');
    expect(sub.active).toBe(true);
  });

  test('create topic subscription', async ({ request }) => {
    const res = await request.post(`${BASE}/v1/subscriptions`, {
      headers: apiAuth(subscriber),
      data: {
        type: 'topic',
        topicId: topic.id,
        notificationMethod: 'polling',
      },
    });

    expect(res.status()).toBe(201);
    const json = await res.json();
    const sub = json.data || json;
    expect(sub.type).toBe('topic');
    expect(sub.active).toBe(true);
  });

  test('list subscriptions returns created subscriptions', async ({ request }) => {
    const res = await request.get(`${BASE}/v1/subscriptions/me`, {
      headers: apiAuth(subscriber),
    });

    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.data).toBeDefined();
    expect(json.data.length).toBeGreaterThanOrEqual(2);
  });

  test('polling endpoint returns notifications', async ({ request }) => {
    const res = await request.get(`${BASE}/v1/subscriptions/notifications`, {
      headers: apiAuth(subscriber),
    });

    expect(res.status()).toBe(200);
    const json = await res.json();
    // May be empty if no chunks matched yet, but endpoint works
    expect(json.data).toBeDefined();
    expect(Array.isArray(json.data)).toBe(true);
  });
});
