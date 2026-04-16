/* eslint-disable no-console */
// HTTP-level E2E for model identity plumbing on POST /ai/actions.
// Exercises: migration 061 column, X-Agent-Model header extraction, route
// -> service -> DB path, and the agent dispatch mode fast path (no provider
// dependency). Run inside aingram-api-test: node scripts/e2e-model-identity.js
//
// Uses the actual HTTP route, actual auth, actual DB. Only mock is the
// Uses an agent-webhook provider (endpoint_kind='agent') to avoid real LLM calls.
// Cleans up its own rows at the end.

const http = require('http');
const { Pool } = require('pg');

const HOST = '127.0.0.1';
const PORT = 3000;
const TS = Date.now();

const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

let humanId = null;
let humanCookie = null;
let agentId = null;
let passed = 0, failed = 0;

function request(method, path, body, { cookie, xAgentModel } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    if (xAgentModel !== undefined) headers['X-Agent-Model'] = xAgentModel;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ hostname: HOST, port: PORT, path, method, headers }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
        resolve({ status: res.statusCode, data: parsed, setCookie: res.headers['set-cookie'] });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function assert(cond, label) {
  if (cond) { console.log(`  PASS ${label}`); passed++; }
  else { console.log(`  FAIL ${label}`); failed++; }
}

async function setup() {
  console.log('-- Setup --');
  let res = await request('POST', '/accounts/register', {
    name: `e2e-model-ident-${TS}`,
    type: 'human',
    ownerEmail: `model-ident-${TS}@e2e.test`,
    password: 'TestPass123!',
    termsAccepted: true,
  });
  if (res.status !== 201) throw new Error(`register: ${res.status} ${JSON.stringify(res.data)}`);
  humanId = (res.data.data || res.data).account.id;
  await pool.query("UPDATE accounts SET status='active', email_confirmed=true WHERE id=$1", [humanId]);

  res = await request('POST', '/accounts/login', {
    email: `model-ident-${TS}@e2e.test`,
    password: 'TestPass123!',
  });
  if (res.status !== 200) throw new Error(`login: ${res.status}`);
  humanCookie = res.setCookie.map((c) => c.split(';')[0]).join('; ');

  res = await request('POST', '/accounts/me/agents', {
    name: `e2e-agent-${TS}`,
    autonomous: false,
  }, { cookie: humanCookie });
  if (res.status !== 201) throw new Error(`create agent: ${res.status} ${JSON.stringify(res.data)}`);
  agentId = (res.data.data || res.data).account.id;

  // Create an agent-webhook provider (endpoint_kind='agent') so executeAction
  // stages a slim envelope without needing a real LLM. Keeps this test focused
  // on the header -> service -> DB plumbing. (D96: routing via provider, not dispatch_mode.)
  await pool.query(
    "UPDATE accounts SET status='active', badge_contribution=true WHERE id=$1",
    [agentId]
  );
  const crypto = require('crypto');
  const webhookProvId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO ai_providers (id, account_id, name, provider_type, model, api_key_encrypted, api_endpoint, is_default, endpoint_kind)
     VALUES ($1, $2, 'E2E Webhook', 'custom', 'e2e-model', 'ffffffffffffffffffffffffffff:ffffffff', 'http://127.0.0.1:1/webhook', true, 'agent')`,
    [webhookProvId, humanId]
  );
  console.log(`  human=${humanId.slice(0,8)} agent=${agentId.slice(0,8)} provider=${webhookProvId.slice(0,8)}\n`);
}

async function cleanup() {
  try {
    if (humanId) {
      await pool.query('DELETE FROM ai_actions WHERE parent_id=$1', [humanId]).catch(() => {});
      await pool.query('DELETE FROM ai_providers WHERE account_id=$1', [humanId]).catch(() => {});
    }
    if (agentId) await pool.query('DELETE FROM accounts WHERE id=$1', [agentId]).catch(() => {});
    if (humanId) await pool.query('DELETE FROM accounts WHERE id=$1', [humanId]).catch(() => {});
  } finally {
    await pool.end();
  }
}

async function modelUsed(actionId) {
  const r = await pool.query('SELECT model_used FROM ai_actions WHERE id=$1', [actionId]);
  return r.rows[0]?.model_used;
}

async function run() {
  console.log('\n=== E2E: X-Agent-Model -> ai_actions.model_used ===\n');

  // Migration sanity
  const col = await pool.query(
    "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name='ai_actions' AND column_name='model_used'"
  );
  assert(col.rows.length === 1, 'migration 061 applied (column exists)');
  assert(col.rows[0]?.data_type === 'text', 'model_used is TEXT');
  assert(col.rows[0]?.is_nullable === 'YES', 'model_used is nullable');

  await setup();

  // Case 1: header carries valid model -> stored verbatim
  console.log('-- Case 1: valid X-Agent-Model -> stored --');
  let res = await request('POST', '/ai/actions', {
    agentId, actionType: 'contribute', targetType: 'topic', targetId: null,
    context: { topicTitle: 'Smoke' },
  }, { cookie: humanCookie, xAgentModel: 'claude-opus-4-6' });
  assert(res.status === 200, `status 200 (got ${res.status} ${JSON.stringify(res.data).slice(0,200)})`);
  const m1 = await modelUsed((res.data?.data || res.data)?.actionId);
  assert(m1 === 'claude-opus-4-6', `model_used = "${m1}" (expected claude-opus-4-6)`);

  // Case 2: no header -> NULL
  console.log('\n-- Case 2: missing header -> NULL --');
  res = await request('POST', '/ai/actions', {
    agentId, actionType: 'contribute', targetType: 'topic', targetId: null,
    context: { topicTitle: 'Smoke' },
  }, { cookie: humanCookie });
  assert(res.status === 200, `status 200 (got ${res.status})`);
  const m2 = await modelUsed((res.data?.data || res.data)?.actionId);
  assert(m2 === null, `model_used = ${m2 === null ? 'NULL' : `"${m2}"`} (expected NULL)`);

  // Case 3: header with spaces -> sanitized to NULL (not stored as raw)
  console.log('\n-- Case 3: invalid header (spaces) -> NULL, no crash --');
  res = await request('POST', '/ai/actions', {
    agentId, actionType: 'contribute', targetType: 'topic', targetId: null,
    context: { topicTitle: 'Smoke' },
  }, { cookie: humanCookie, xAgentModel: 'claude opus 4' });
  assert(res.status === 200, `status 200 (got ${res.status})`);
  const m3 = await modelUsed((res.data?.data || res.data)?.actionId);
  assert(m3 === null, `model_used = ${m3 === null ? 'NULL' : `"${m3}"`} (expected NULL — sanitized)`);

  // Case 4: SQL-injection-ish header -> NULL, no crash
  console.log('\n-- Case 4: SQL-injection-ish header -> NULL, no crash --');
  res = await request('POST', '/ai/actions', {
    agentId, actionType: 'contribute', targetType: 'topic', targetId: null,
    context: { topicTitle: 'Smoke' },
  }, { cookie: humanCookie, xAgentModel: "x'; DROP TABLE ai_actions; --" });
  assert(res.status === 200, `status 200 (got ${res.status})`);
  const m4 = await modelUsed((res.data?.data || res.data)?.actionId);
  assert(m4 === null, `model_used = ${m4 === null ? 'NULL' : `"${m4}"`} (expected NULL — rejected)`);
  // Table still exists
  const tableStill = await pool.query("SELECT COUNT(*) FROM ai_actions WHERE parent_id=$1", [humanId]);
  assert(parseInt(tableStill.rows[0].count, 10) >= 4, 'ai_actions table intact after injection attempt');

  // Case 5: header longer than 128 chars -> truncated
  console.log('\n-- Case 5: over-length header -> 128-char cap --');
  const longModel = 'a'.repeat(200);
  res = await request('POST', '/ai/actions', {
    agentId, actionType: 'contribute', targetType: 'topic', targetId: null,
    context: { topicTitle: 'Smoke' },
  }, { cookie: humanCookie, xAgentModel: longModel });
  assert(res.status === 200, `status 200 (got ${res.status})`);
  const m5 = await modelUsed((res.data?.data || res.data)?.actionId);
  assert(m5 && m5.length === 128, `model_used length = ${m5 && m5.length} (expected 128)`);
}

(async () => {
  try {
    await run();
  } catch (err) {
    console.error('CRASH:', err.stack || err.message);
    failed++;
  } finally {
    await cleanup();
    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
    process.exit(failed ? 1 : 0);
  }
})();
