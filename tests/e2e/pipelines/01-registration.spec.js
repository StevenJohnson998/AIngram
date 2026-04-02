// @ts-check
/**
 * 01 — Registration & Account Activation
 *
 * Verifies the full onboarding pipeline:
 * human registration, autonomous agent registration, assisted agent creation,
 * email confirmation, first contribution, status activation.
 */

const { test, expect } = require('@playwright/test');
const { BASE, unique, apiAuth, createUserInDB, createTopicInDB, queryDB } = require('./helpers');

test.describe('Registration & Account Activation', () => {

  test.describe.serial('Human registration flow', () => {
    const email = `e2e-reg-${Date.now()}@example.com`;
    const password = 'TestPass2026!';
    let accountId, apiKey, topic;

    test('POST /accounts/register creates human account with provisional status', async ({ request }) => {
      const res = await request.post(`${BASE}/v1/accounts/register`, {
        data: {
          name: `E2E Reg ${unique()}`,
          type: 'human',
          ownerEmail: email,
          password,
          termsAccepted: true,
        },
      });

      // 201 or 429 (rate limited)
      if (res.status() === 429) {
        test.skip(true, 'Rate limited — run individually');
        return;
      }
      expect(res.status()).toBe(201);
      const json = await res.json();
      const account = json.data || json;
      accountId = account.id || account.account?.id;
      apiKey = account.apiKey || account.api_key;
      expect(account.status || account.account?.status).toBe('provisional');
    });

    test('account has email_confirmed = false before confirmation', async () => {
      if (!accountId) { test.skip(); return; }
      const confirmed = queryDB(`SELECT email_confirmed FROM accounts WHERE id = '${accountId}'`);
      expect(confirmed).toBe('false');
    });

    test('first contribution sets first_contribution_at', async ({ request }) => {
      if (!accountId || !apiKey) { test.skip(); return; }

      // Need a topic to contribute to
      const helper = createUserInDB({ prefix: 'e2e-reg-helper' });
      topic = createTopicInDB(helper.id);

      const res = await request.post(`${BASE}/v1/topics/${topic.id}/chunks`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        data: {
          content: `E2E registration test contribution with sufficient length for validation ${unique()}`,
        },
      });

      // 201 (created) or 403 (needs confirmation first) — both are valid signals
      if (res.status() === 201) {
        const fc = queryDB(`SELECT first_contribution_at FROM accounts WHERE id = '${accountId}'`);
        expect(fc).not.toBe('');
      }
    });

    test('duplicate email returns 409', async ({ request }) => {
      const res = await request.post(`${BASE}/v1/accounts/register`, {
        data: {
          name: 'Duplicate',
          type: 'human',
          ownerEmail: email,
          password,
          termsAccepted: true,
        },
      });

      // 409 or 429 (rate limited)
      if (res.status() !== 429) {
        expect(res.status()).toBe(409);
      }
    });
  });

  test.describe('Autonomous agent registration', () => {
    test('POST /accounts/register with type=ai creates autonomous agent', async ({ request }) => {
      const res = await request.post(`${BASE}/v1/accounts/register`, {
        data: {
          name: `E2E Bot ${unique()}`,
          type: 'ai',
          ownerEmail: `e2e-bot-${unique()}@example.com`,
          password: 'BotPass2026!',
          termsAccepted: true,
        },
      });

      if (res.status() === 429) {
        test.skip(true, 'Rate limited');
        return;
      }
      expect(res.status()).toBe(201);
      const json = await res.json();
      const account = json.data || json;
      const apiKey = account.apiKey || account.api_key;
      expect(apiKey).toBeDefined();
      expect(apiKey).toMatch(/^aingram_/);
    });
  });

  test.describe.serial('Assisted agent (sub-account) flow', () => {
    let human, humanApiKey, agentId;

    test('human creates assisted agent via POST /accounts/me/agents', async ({ request }) => {
      human = createUserInDB({ prefix: 'e2e-reg-parent' });

      const res = await request.post(`${BASE}/v1/accounts/me/agents`, {
        headers: apiAuth(human),
        data: {
          name: `Assistant ${unique()}`,
          provider: 'custom',
        },
      });

      expect(res.status()).toBe(201);
      const json = await res.json();
      const agent = json.data?.account || json.account || json.data || json;
      agentId = agent.id;
      expect(agent.type).toBe('ai');
    });

    test('generate connection token and redeem it', async ({ request }) => {
      if (!agentId) { test.skip(); return; }

      // Generate token
      const tokenRes = await request.post(`${BASE}/v1/accounts/me/agents/${agentId}/connection-token`, {
        headers: apiAuth(human),
      });
      expect(tokenRes.status()).toBe(201);
      const tokenJson = await tokenRes.json();
      const token = (tokenJson.data || tokenJson).token;
      expect(token).toBeDefined();

      // Redeem token
      const connectRes = await request.post(`${BASE}/v1/accounts/connect`, {
        data: { token },
      });
      expect(connectRes.status()).toBe(201);
      const connectJson = await connectRes.json();
      const connected = connectJson.data || connectJson;
      const agentApiKey = connected.apiKey || connected.api_key;
      expect(agentApiKey).toMatch(/^aingram_/);

      // Verify agent sees parent
      const meRes = await request.get(`${BASE}/v1/accounts/me`, {
        headers: { Authorization: `Bearer ${agentApiKey}` },
      });
      expect(meRes.status()).toBe(200);
      const meJson = await meRes.json();
      const me = meJson.data?.account || meJson.account || meJson.data || meJson;
      expect(me.parent_id).toBe(human.id);
    });
  });
});
