// @ts-check
/**
 * 14 — GUI contribution dispatch mode (ADR D95)
 *
 * Verifies the per-user dispatch_mode routing in POST /v1/ai/actions:
 *   - dispatch_mode = 'llm'   → provider is called (or error if none configured)
 *   - dispatch_mode = 'agent' → slim envelope staged, NO provider call
 *   - dispatch_mode = NULL    → defaults to 'llm'
 *
 * The agent path is the observable-only form: the envelope is stored in
 * ai_actions.result and returned in the HTTP response. The receiver side
 * (agent actually pulling tasks) is out of scope until the dispatch
 * protocol (MCP queue / webhook) is picked.
 */

const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');
const crypto = require('crypto');
const {
  BASE, apiAuth, createUserInDB, createSubAccountInDB,
} = require('./helpers');

const API = process.env.API_CONTAINER || 'aingram-api-test';

/** Set the dispatch_mode on an account row (direct DB update — test-only). */
function setDispatchMode(accountId, mode) {
  const modeSql = mode === null ? 'NULL' : `'${mode}'`;
  const script = `
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    (async () => {
      await pool.query("UPDATE accounts SET dispatch_mode = ${modeSql} WHERE id = $1", ['${accountId}']);
      console.log('ok');
      await pool.end();
    })();
  `;
  execSync(`docker exec -i ${API} node`, { input: script, encoding: 'utf-8', timeout: 10000 });
}

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

/** Create a provider for this root human (fake endpoint — won't succeed but provider exists). */
function createProviderInDB(parentId) {
  const script = `
    const crypto = require('crypto');
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    (async () => {
      const id = crypto.randomUUID();
      await pool.query(
        "INSERT INTO ai_providers (id, account_id, name, provider_type, model, api_key_encrypted, api_endpoint, is_default) VALUES ($1, $2, 'TestProv', 'custom', 'test-model', 'ffffffffffffffffffffffffffff:ffffffff', 'http://127.0.0.1:9', true)",
        [id, '${parentId}']
      );
      console.log(JSON.stringify({ id }));
      await pool.end();
    })();
  `;
  const raw = execSync(`docker exec -i ${API} node`, { input: script, encoding: 'utf-8', timeout: 10000 }).trim();
  return JSON.parse(raw);
}

test.describe.serial('Dispatch mode routing (D95)', () => {
  let human, agent;

  test.beforeAll(async () => {
    human = createUserInDB({ prefix: 'e2e-d95' });
    agent = createSubAccountInDB(human.id);
  });

  test('dispatch_mode=agent stages slim envelope, no provider called', async ({ request }) => {
    setDispatchMode(agent.id, 'agent');

    const res = await request.post(`${BASE}/v1/ai/actions`, {
      headers: apiAuth(human),
      data: {
        agentId: agent.id,
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

    // DB row must have provider_id=NULL (key structural invariant for agent mode)
    const row = readActionRow(body.actionId);
    expect(row).not.toBeNull();
    expect(row.provider_id).toBeNull();
    expect(row.status).toBe('pending');
    expect(row.result.status).toBe('pending_agent_dispatch');
    expect(row.result.envelope.action).toBe('contribute');
  });

  test('dispatch_mode=llm without provider returns PROVIDER_REQUIRED', async ({ request }) => {
    setDispatchMode(agent.id, 'llm');
    // Ensure no provider: this parent has none from beforeAll.

    const res = await request.post(`${BASE}/v1/ai/actions`, {
      headers: apiAuth(human),
      data: {
        agentId: agent.id,
        actionType: 'review',
        targetType: 'chunk',
        targetId: crypto.randomUUID(),
        context: { content: 'Some chunk content to review.' },
      },
    });

    expect(res.status()).toBe(400);
    const json = await res.json();
    // Error bodies may or may not be wrapped depending on middleware
    const errBody = json.data || json;
    expect(errBody.error.code).toBe('PROVIDER_REQUIRED');
  });

  test('dispatch_mode=llm with provider dispatches through the provider path', async ({ request }) => {
    setDispatchMode(agent.id, 'llm');
    const provider = createProviderInDB(human.id);

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

    // Provider endpoint is 127.0.0.1:9 (unreachable) — AIngram should fail the
    // call and record it as failed. Important: we're verifying that the LLM
    // path was taken (provider resolved + call attempted), not that it
    // succeeds. Success would require a real mock LLM server, out of scope here.
    expect([200, 500]).toContain(res.status());
    const json = await res.json();
    const body = json.data || json;

    if (res.status() === 500) {
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('INTERNAL_ERROR');
    } else {
      // If somehow 200, verify it ran through provider (non-null provider row)
      const row = readActionRow(body.actionId);
      expect(row.provider_id).not.toBeNull();
    }
  });

  test('dispatch_mode=NULL defaults to llm (with provider works identically)', async ({ request }) => {
    setDispatchMode(agent.id, null);
    // Provider from previous test still exists (is_default=true on human).

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

    // Same behavior as llm with unreachable provider: 500 (or 200 only if mocked).
    expect([200, 500]).toContain(res.status());
    // Envelope status must NOT be pending_agent_dispatch (we're in llm, not agent mode).
    if (res.status() === 200) {
      const json = await res.json();
      const body = json.data || json;
      expect(body.result?.status).not.toBe('pending_agent_dispatch');
    }
  });
});
