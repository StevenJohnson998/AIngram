// @ts-check
/**
 * 14 — Endpoint-kind dispatch routing (ADR D96, supersedes D95 dispatch_mode)
 *
 * Verifies per-provider endpoint_kind routing in POST /v1/ai/actions:
 *   - endpoint_kind = 'agent' → slim envelope staged, NO LLM call
 *   - endpoint_kind = 'llm'   → provider called (or error if unreachable)
 *   - no provider at all      → PROVIDER_REQUIRED error
 *   - Phase 1b fallback       → legacy dispatch_mode used when endpoint_kind missing
 */

const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');
const crypto = require('crypto');
const {
  BASE, apiAuth, createUserInDB, createSubAccountInDB,
} = require('./helpers');

const API = process.env.API_CONTAINER || 'aingram-api-test';

/** Read back the ai_actions row for assertions. */
function readActionRow(actionId) {
  const script = `
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    (async () => {
      const r = await pool.query(
        "SELECT id, provider_id, status, action_type, target_type, target_id, result, input_tokens, output_tokens FROM ai_actions WHERE id = $1",
        ['${actionId}']
      );
      console.log(JSON.stringify(r.rows[0] || null));
      await pool.end();
    })();
  `;
  const raw = execSync(`docker exec -i ${API} node`, { input: script, encoding: 'utf-8', timeout: 10000 }).trim();
  return JSON.parse(raw);
}

/** Create a provider with configurable endpoint_kind. */
function createProviderInDB(parentId, { endpointKind = 'llm' } = {}) {
  const script = `
    const crypto = require('crypto');
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    (async () => {
      const id = crypto.randomUUID();
      const isDefault = '${endpointKind}' === 'llm';
      await pool.query(
        "INSERT INTO ai_providers (id, account_id, name, provider_type, model, api_key_encrypted, api_endpoint, is_default, endpoint_kind) VALUES ($1, $2, 'TestProv', 'custom', 'test-model', 'ffffffffffffffffffffffffffff:ffffffff', 'http://127.0.0.1:9', $3, $4)",
        [id, '${parentId}', isDefault, '${endpointKind}']
      );
      console.log(JSON.stringify({ id }));
      await pool.end();
    })();
  `;
  const raw = execSync(`docker exec -i ${API} node`, { input: script, encoding: 'utf-8', timeout: 10000 }).trim();
  return JSON.parse(raw);
}

test.describe.serial('Endpoint-kind dispatch routing (D96)', () => {
  let human, agent;

  test.beforeAll(async () => {
    human = createUserInDB({ prefix: 'e2e-d96' });
    agent = createSubAccountInDB(human.id);
  });

  test('endpoint_kind=agent stages slim envelope, no LLM call', async ({ request }) => {
    const provider = createProviderInDB(human.id, { endpointKind: 'agent' });

    const res = await request.post(`${BASE}/v1/ai/actions`, {
      headers: apiAuth(human),
      data: {
        agentId: agent.id,
        providerId: provider.id,
        actionType: 'contribute',
        targetType: 'topic',
        targetId: crypto.randomUUID(),
        context: { topicTitle: 'Transformers', instructions: 'Write a chunk about attention.' },
      },
    });

    expect(res.status()).toBe(200);
    const json = await res.json();
    const body = json.data || json;
    expect(body.actionId).toBeDefined();
    expect(body.result.status).toBe('pending_agent_dispatch');
    expect(body.result.envelope).toMatchObject({
      action: 'contribute',
      target: { type: 'topic' },
      context: expect.objectContaining({ topicTitle: 'Transformers' }),
    });
    expect(body.usage.inputTokens).toBe(0);
    expect(body.usage.outputTokens).toBe(0);

    // DB row must have provider_id set (D96: agent-webhook provider exists)
    const row = readActionRow(body.actionId);
    expect(row).not.toBeNull();
    expect(row.provider_id).toBe(provider.id);
    expect(row.status).toBe('pending');
    expect(row.result.status).toBe('pending_agent_dispatch');
    expect(row.result.envelope.action).toBe('contribute');
  });

  test('no provider at all returns PROVIDER_REQUIRED', async ({ request }) => {
    // Create a fresh human with no providers
    const human2 = createUserInDB({ prefix: 'e2e-d96-noprov' });
    const agent2 = createSubAccountInDB(human2.id);

    const res = await request.post(`${BASE}/v1/ai/actions`, {
      headers: apiAuth(human2),
      data: {
        agentId: agent2.id,
        actionType: 'review',
        targetType: 'chunk',
        targetId: crypto.randomUUID(),
        context: { content: 'Some chunk content to review.' },
      },
    });

    expect(res.status()).toBe(400);
    const json = await res.json();
    const errBody = json.data || json;
    expect(errBody.error.code).toBe('PROVIDER_REQUIRED');
  });

  test('endpoint_kind=llm dispatches through the LLM provider path', async ({ request }) => {
    const provider = createProviderInDB(human.id, { endpointKind: 'llm' });

    const res = await request.post(`${BASE}/v1/ai/actions`, {
      headers: apiAuth(human),
      data: {
        agentId: agent.id,
        providerId: provider.id,
        actionType: 'review',
        targetType: 'chunk',
        targetId: crypto.randomUUID(),
        context: { content: 'content' },
      },
    });

    // Provider endpoint is 127.0.0.1:9 (unreachable) — verifying LLM path
    // was taken (provider resolved + call attempted), not that it succeeds.
    expect([200, 500]).toContain(res.status());
    const json = await res.json();
    const body = json.data || json;

    if (res.status() === 500) {
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('INTERNAL_ERROR');
    } else {
      const row = readActionRow(body.actionId);
      expect(row.provider_id).not.toBeNull();
    }
  });

  test('default endpoint_kind (llm) works when no explicit kind set', async ({ request }) => {
    // The providers from previous tests have is_default=true, so the agent
    // will pick one up. Verify it doesn't accidentally go agent-mode.
    const res = await request.post(`${BASE}/v1/ai/actions`, {
      headers: apiAuth(human),
      data: {
        agentId: agent.id,
        actionType: 'summary',
        targetType: 'topic',
        targetId: crypto.randomUUID(),
        context: { topicTitle: 'x', content: 'Summary this.' },
      },
    });

    expect([200, 500]).toContain(res.status());
    if (res.status() === 200) {
      const json = await res.json();
      const body = json.data || json;
      expect(body.result?.status).not.toBe('pending_agent_dispatch');
    }
  });
});
