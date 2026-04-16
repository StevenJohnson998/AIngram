// @ts-check
/**
 * GUI E2E — endpoint_kind routing with real browser + mock LLM (ADR D96)
 *
 * Clicks the actual "AI Review" button on a topic page with two agents:
 *   - Agent A — provider with endpoint_kind='agent', slim envelope staged
 *   - Agent B — provider with endpoint_kind='llm' pointing to a mock LLM
 *
 * Both results are rendered in the same GUI container (#ai-result-<chunkId>).
 * Screenshots are written to test-results/ so the run is visually auditable.
 *
 * Run: npx playwright test tests/e2e/gui-dispatch-mode
 */

const { test, expect } = require('@playwright/test');
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');

const BASE = process.env.BASE_URL || 'http://172.18.0.19:3000';
const API = process.env.API_CONTAINER || 'aingram-api-test';
// Mock runs INSIDE the API container so the provider fetch can use
// loopback — host→container on arbitrary ports is blocked by the docker
// FORWARD iptables chain on this host.
const MOCK_PORT_INSIDE_CONTAINER = process.env.MOCK_LLM_PORT || 19099;

const unique = () => crypto.randomBytes(4).toString('hex');

function execInApi(script) {
  return execSync(`docker exec -i ${API} node`, {
    input: script, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

function seedScenario(mockPortInsideContainer) {
  const mockPort = mockPortInsideContainer;
  // One-shot DB seed: user (with password + JWT session fodder), two agents,
  // topic, chunk, provider pointing to the mock.
  const pwd = 'TestPass2026!';
  const email = `e2e-gui-d95-${unique()}@example.com`;
  const userName = `gui-d95-${unique()}`;
  const script = `
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    (async () => {
      const userId = crypto.randomUUID();
      const pwHash = bcrypt.hashSync('${pwd}', 10);
      const pfx = crypto.randomBytes(4).toString('hex');
      const secret = crypto.randomBytes(12).toString('hex');
      const keyHash = bcrypt.hashSync(secret, 10);
      await pool.query(
        \`INSERT INTO accounts (id, name, type, owner_email, password_hash, status, email_confirmed, tier,
           badge_policing, badge_contribution, reputation_contribution, reputation_copyright,
           first_contribution_at, terms_version_accepted, api_key_hash, api_key_prefix)
          VALUES ($1, '${userName}', 'human', '${email}', $2, 'active', true, 0,
                  false, false, 0.5, 0.5, now(), '2026-03-21-v1', $3, $4)\`,
        [userId, pwHash, keyHash, pfx]
      );

      // Two assisted agents (D96: routing is via provider.endpoint_kind, not account.dispatch_mode)
      const agentA = crypto.randomUUID();
      const agentB = crypto.randomUUID();
      for (const [id, name] of [[agentA, 'AgentMode-A'], [agentB, 'LlmMode-B']]) {
        await pool.query(
          \`INSERT INTO accounts (id, name, type, owner_email, parent_id, status, autonomous, tier,
             first_contribution_at, terms_version_accepted)
            VALUES ($1, $2, 'ai', '${email}', $3, 'active', false, 0,
                    now(), '2026-03-21-v1')\`,
          [id, name, userId]
        );
      }

      // Topic + chunk for the AI Review button to attach to
      const topicSlug = 'e2e-gui-d95-' + crypto.randomBytes(3).toString('hex');
      const topicRes = await pool.query(
        "INSERT INTO topics (title, slug, lang, summary, sensitivity, created_by) VALUES ($1, $2, 'en', 'Seeded topic for dispatch_mode GUI test.', 'standard', $3) RETURNING id",
        ['D95 GUI Seed', topicSlug, userId]
      );
      const topicId = topicRes.rows[0].id;

      const chunkRes = await pool.query(
        "INSERT INTO chunks (title, content, created_by, trust_score, status) VALUES ($1, $2, $3, 0.6, 'published') RETURNING id",
        ['Seed chunk', 'Transformer architectures use attention mechanisms. This seeded chunk provides content for the AI Review button to act on.', userId]
      );
      const chunkId = chunkRes.rows[0].id;
      await pool.query("INSERT INTO chunk_topics (chunk_id, topic_id) VALUES ($1, $2)", [chunkId, topicId]);

      // Provider for the LLM-mode agent. We insert directly in SQL to bypass
      // validateEndpoint (which blocks 172.16-31.x.x private ranges as SSRF
      // protection — legitimate in prod, but here the mock LLM lives on the
      // docker host gateway precisely on that range). We still encrypt the
      // api_key_encrypted via the same crypto primitives the service uses so
      // the running process can decrypt it at call time.
      const crypto2 = require('crypto');
      const rawKey = 'sk-mock-unused';
      const keyHashed = crypto2.scryptSync(process.env.JWT_SECRET, 'aingram-provider', 32);
      const iv = crypto2.randomBytes(16);
      const cipher = crypto2.createCipheriv('aes-256-cbc', keyHashed, iv);
      const encrypted = Buffer.concat([cipher.update(rawKey, 'utf8'), cipher.final()]);
      const stored = iv.toString('hex') + ':' + encrypted.toString('hex');

      // Provider for Agent A: agent-webhook (endpoint_kind='agent')
      const providerAgentId = crypto.randomUUID();
      await pool.query(
        \`INSERT INTO ai_providers (id, account_id, name, provider_type, api_endpoint, model, api_key_encrypted, max_tokens, temperature, is_default, endpoint_kind)
          VALUES ($1, $2, 'AgentWebhook', 'custom', 'http://127.0.0.1:1/webhook', 'agent-model', $3, 1024, 0.7, false, 'agent')\`,
        [providerAgentId, userId, stored]
      );
      // Assign agent-webhook provider to Agent A
      await pool.query("UPDATE accounts SET provider_id = $1 WHERE id = $2", [providerAgentId, agentA]);

      // Provider for Agent B: LLM (endpoint_kind='llm', default)
      const providerId = crypto.randomUUID();
      await pool.query(
        \`INSERT INTO ai_providers (id, account_id, name, provider_type, api_endpoint, model, api_key_encrypted, max_tokens, temperature, is_default, endpoint_kind)
          VALUES ($1, $2, 'MockProv', 'custom', $3, 'mock-model', $4, 1024, 0.7, true, 'llm')\`,
        [providerId, userId, 'http://127.0.0.1:${mockPort}/v1/chat/completions', stored]
      );
      // Assign LLM provider to Agent B
      await pool.query("UPDATE accounts SET provider_id = $1 WHERE id = $2", [providerId, agentB]);

      console.log(JSON.stringify({
        userId, email: '${email}', password: '${pwd}',
        agentA, agentB, topicId, topicSlug, chunkId,
        providerId, providerAgentId,
      }));
      await pool.end();
    })();
  `;
  return JSON.parse(execInApi(script));
}

function readActionRow(actionId) {
  const script = `
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    (async () => {
      const r = await pool.query(
        "SELECT provider_id, status, result FROM ai_actions WHERE id = $1",
        ['${actionId}']
      );
      console.log(JSON.stringify(r.rows[0] || null));
      await pool.end();
    })();
  `;
  return JSON.parse(execInApi(script));
}

test.describe.serial('GUI endpoint_kind (D96) — real browser + mock LLM', () => {
  let scenario;
  const mockCountFile = `/tmp/mock-llm-count-${unique()}.txt`;

  test.beforeAll(async () => {
    // Spawn a minimal OpenAI-compatible mock INSIDE the aingram-api-test
    // container and have the provider target 127.0.0.1:<port>. We use a
    // counter file to observe whether the mock was hit (assertion needs
    // cross-process visibility; the mock is a separate child process).
    const mockScript = `
      const http = require('http');
      const fs = require('fs');
      const COUNT = '${mockCountFile}';
      fs.writeFileSync(COUNT, '0');
      const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => body += c);
        req.on('end', () => {
          fs.writeFileSync(COUNT, String(Number(fs.readFileSync(COUNT, 'utf8')) + 1));
          const payload = {
            choices: [{ message: { content: JSON.stringify({
              content: 'Mocked LLM review — chunk looks accurate, one minor nit.',
              vote: 'positive',
              flag: null,
              confidence: 0.85,
              added_value: 0.6,
            }) } }],
            usage: { prompt_tokens: 42, completion_tokens: 17 },
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        });
      });
      srv.listen(${MOCK_PORT_INSIDE_CONTAINER}, '127.0.0.1', () => {
        fs.writeFileSync('/tmp/mock-llm.pid', String(process.pid));
      });
    `;
    // Write the mock to /app (node_modules available is irrelevant here,
    // pure-stdlib). Use sh -c to launch detached so docker exec returns.
    execSync(`docker exec -i ${API} sh -c 'cat > /tmp/mock-llm.js'`, {
      input: mockScript, encoding: 'utf-8', timeout: 5000,
    });
    execSync(`docker exec -i ${API} sh -c 'nohup node /tmp/mock-llm.js > /tmp/mock-llm.log 2>&1 &'`, {
      encoding: 'utf-8', timeout: 5000,
    });
    // Tiny poll: wait for /tmp/mock-llm.pid to exist (mock listening)
    for (let i = 0; i < 10; i++) {
      try {
        execSync(`docker exec ${API} test -f /tmp/mock-llm.pid`, { timeout: 2000 });
        break;
      } catch { await new Promise(r => setTimeout(r, 100)); }
    }

    scenario = seedScenario(MOCK_PORT_INSIDE_CONTAINER);
  });

  test.afterAll(async () => {
    try {
      execSync(`docker exec ${API} sh -c 'pkill -f /tmp/mock-llm.js || true'`, { timeout: 5000 });
    } catch { /* best-effort cleanup */ }
  });

  function readMockCount() {
    const raw = execSync(`docker exec ${API} cat ${mockCountFile}`, { encoding: 'utf-8', timeout: 3000 }).trim();
    return Number(raw);
  }

  async function loginViaGui(page) {
    await page.goto(`${BASE}/login.html`);
    await page.locator('#email').fill(scenario.email);
    await page.locator('#password').fill(scenario.password);
    await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/accounts/login') && r.request().method() === 'POST'),
      page.locator('#login-btn').click(),
    ]);
    // After login, navbar-auth-check happens; we wait for /accounts/me
    await page.waitForResponse(r => r.url().endsWith('/accounts/me')).catch(() => {});
  }

  async function gotoTopicAndWaitForPersonaBar(page) {
    await page.goto(`${BASE}/topic.html?slug=${scenario.topicSlug}`);
    // Persona bar becomes visible after /accounts/me/agents loads both agents
    await expect(page.locator('#persona-bar')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#persona-selector .persona-btn')).toHaveCount(2);
    // Chunk must be rendered so the .chunk-ai-review button exists
    const reviewBtn = page.locator(`button.chunk-ai-review[data-id="${scenario.chunkId}"]`);
    await expect(reviewBtn).toBeVisible({ timeout: 10000 });
    return reviewBtn;
  }

  async function selectPersonaByName(page, name) {
    const btn = page.locator('#persona-selector .persona-btn', { hasText: name });
    await btn.click();
    await expect(btn).toHaveClass(/active/);
  }

  test('agent-mode agent: clicking AI Review stages slim envelope (no LLM call)', async ({ page, context }) => {
    // Record accepted dialogs to assert nothing popped up
    const dialogs = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });

    await loginViaGui(page);
    const reviewBtn = await gotoTopicAndWaitForPersonaBar(page);
    await selectPersonaByName(page, 'AgentMode-A');

    const receivedBefore = readMockCount();

    const [aiRes] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/ai/actions') && r.request().method() === 'POST'),
      reviewBtn.click(),
    ]);
    expect(aiRes.status()).toBe(200);

    const resultContainer = page.locator(`#ai-result-${scenario.chunkId}`);
    await expect(resultContainer.locator('.ai-result-preview')).toBeVisible({ timeout: 10000 });

    // In agent mode the result rendered is the JSONified envelope (the GUI
    // uses result.content || JSON.stringify(result)). We assert on the
    // telltale envelope shape.
    const bodyText = await resultContainer.locator('.ai-result-body').textContent();
    expect(bodyText).toContain('pending_agent_dispatch');
    expect(bodyText).toContain('envelope');

    // Mock LLM must not have been touched in agent mode
    expect(readMockCount()).toBe(receivedBefore);

    // DB side-effect: ai_actions row has provider_id set to the webhook provider (D96)
    const json = await aiRes.json();
    const actionId = (json.data || json).actionId;
    const row = readActionRow(actionId);
    expect(row.provider_id).toBe(scenario.providerAgentId);
    expect(row.status).toBe('pending');
    expect(row.result.status).toBe('pending_agent_dispatch');

    await page.screenshot({ path: 'test-results/gui-dispatch-mode-agent.png', fullPage: true });
    expect(dialogs).toEqual([]);
  });

  test('llm-mode agent: clicking AI Review calls the mock provider + renders content', async ({ page }) => {
    const dialogs = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });

    await loginViaGui(page);
    const reviewBtn = await gotoTopicAndWaitForPersonaBar(page);
    await selectPersonaByName(page, 'LlmMode-B');

    const receivedBefore = readMockCount();

    const [aiRes] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/ai/actions') && r.request().method() === 'POST', { timeout: 15000 }),
      reviewBtn.click(),
    ]);
    expect(aiRes.status()).toBe(200);

    const resultContainer = page.locator(`#ai-result-${scenario.chunkId}`);
    await expect(resultContainer.locator('.ai-result-preview')).toBeVisible({ timeout: 10000 });

    // Mock LLM was called exactly once for this click
    expect(readMockCount()).toBe(receivedBefore + 1);

    // Rendered content is the mocked review text
    const bodyText = await resultContainer.locator('.ai-result-body').textContent();
    expect(bodyText).toContain('Mocked LLM review');

    // Vote badge appears for positive review
    await expect(resultContainer.locator('.ai-result-header')).toContainText('positive');

    // DB row: provider_id set, status='completed', result has our content
    const json = await aiRes.json();
    const actionId = (json.data || json).actionId;
    const row = readActionRow(actionId);
    expect(row.provider_id).toBe(scenario.providerId);
    expect(row.status).toBe('completed');
    expect(row.result.content).toContain('Mocked LLM review');
    expect(row.result.vote).toBe('positive');

    await page.screenshot({ path: 'test-results/gui-dispatch-mode-llm.png', fullPage: true });
    expect(dialogs).toEqual([]);
  });
});
