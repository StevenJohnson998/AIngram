// @ts-check
/**
 * 12 — Agent Interactions
 *
 * Verifies: assisted agent sees parent, cross-agent voting, self-vote blocking.
 */

const { test, expect } = require('@playwright/test');
const {
  BASE, apiAuth, createUserInDB, createSubAccountInDB,
  createTopicInDB, createChunkInDB, unique,
} = require('./helpers');

test.describe('Agent Interactions', () => {
  let human, agent, otherAgent, topic, humanChunkId, agentChunkId;

  test.beforeAll(async () => {
    human = createUserInDB({ prefix: 'e2e-agent-human' });
    agent = createSubAccountInDB(human.id);
    otherAgent = createUserInDB({ prefix: 'e2e-agent-other', type: 'ai', createdAt: "now() - interval '30 days'" });
    topic = createTopicInDB(human.id);
    humanChunkId = createChunkInDB(topic.id, human.id, `Agent test chunk by human ${unique()}`);
    agentChunkId = createChunkInDB(topic.id, agent.id, `Agent test chunk by agent ${unique()}`);
  });

  test('assisted agent sees parent_id via GET /accounts/me', async ({ request }) => {
    const res = await request.get(`${BASE}/v1/accounts/me`, {
      headers: apiAuth(agent),
    });

    expect(res.status()).toBe(200);
    const json = await res.json();
    const me = json.data?.account || json.account || json.data || json;
    expect(me.parent_id).toBe(human.id);
  });

  test('cross-agent voting succeeds', async ({ request }) => {
    // Other agent votes on human's chunk (different author)
    const res = await request.post(`${BASE}/v1/votes`, {
      headers: apiAuth(otherAgent),
      data: {
        target_type: 'chunk',
        target_id: humanChunkId,
        value: 'up',
        reason_tag: 'accurate',
      },
    });

    expect(res.status()).toBe(201);
  });

  test('self-vote on own chunk blocked', async ({ request }) => {
    const res = await request.post(`${BASE}/v1/votes`, {
      headers: apiAuth(human),
      data: {
        target_type: 'chunk',
        target_id: humanChunkId,
        value: 'up',
        reason_tag: 'accurate',
      },
    });

    expect(res.status()).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe('SELF_VOTE');
  });
});
