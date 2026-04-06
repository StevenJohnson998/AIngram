/**
 * E2E tests for Review Queue improvements.
 * Runs against the live aingram-api-test container with real auth.
 */

const http = require('http');
const { getPool } = require('../config/database');

const HOST = '127.0.0.1';
const PORT = 3000;

let policingKey = null;
let regularKey = null;
let policingAccountId = null;
let regularAccountId = null;
let topicId = null;
let chunkId = null;
let proposedChunkId = null;
let proposedChunkId2 = null;

let passed = 0;
let failed = 0;

function request(method, path, body, apiKey) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = http.request(
      { hostname: HOST, port: PORT, path, method, headers },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
          resolve({ status: res.statusCode, data: parsed });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

async function setup() {
  console.log('-- Setup: create accounts --');
  const pool = getPool();
  const ts = Date.now();

  // Register policing account
  let res = await request('POST', '/accounts/register', {
    name: `e2e-policing-${ts}`,
    type: 'ai',
    ownerEmail: `policing-${ts}@e2e.test`,
    password: 'TestPass123!',
  });
  assert(res.status === 201, `Register policing account: ${res.status}`);
  policingKey = res.data.apiKey;
  policingAccountId = res.data.account.id;

  // Register regular account
  res = await request('POST', '/accounts/register', {
    name: `e2e-regular-${ts}`,
    type: 'ai',
    ownerEmail: `regular-${ts}@e2e.test`,
    password: 'TestPass123!',
  });
  assert(res.status === 201, `Register regular account: ${res.status}`);
  regularKey = res.data.apiKey;
  regularAccountId = res.data.account.id;

  // Grant policing badge + activate both accounts
  await pool.query(
    "UPDATE accounts SET badge_policing = true, status = 'active' WHERE id = $1",
    [policingAccountId]
  );
  await pool.query(
    "UPDATE accounts SET status = 'active' WHERE id = $1",
    [regularAccountId]
  );
  console.log('  Accounts created and configured\n');
}

async function cleanup() {
  const pool = getPool();
  if (policingAccountId) {
    await pool.query('DELETE FROM flags WHERE reporter_id = $1', [policingAccountId]).catch(() => {});
    await pool.query('DELETE FROM chunk_topics WHERE chunk_id IN (SELECT id FROM chunks WHERE created_by = $1 OR proposed_by = $1)', [policingAccountId]).catch(() => {});
    await pool.query('DELETE FROM chunk_topics WHERE chunk_id IN (SELECT id FROM chunks WHERE created_by = $1 OR proposed_by = $1)', [regularAccountId]).catch(() => {});
    await pool.query('DELETE FROM chunks WHERE created_by = $1 OR proposed_by = $1', [regularAccountId]).catch(() => {});
    await pool.query('DELETE FROM chunks WHERE created_by = $1 OR proposed_by = $1', [policingAccountId]).catch(() => {});
    if (topicId) {
      await pool.query('DELETE FROM topics WHERE id = $1', [topicId]).catch(() => {});
    }
    await pool.query('DELETE FROM accounts WHERE id = $1', [policingAccountId]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE id = $1', [regularAccountId]).catch(() => {});
  }
  await pool.end();
}

async function run() {
  console.log('\n=== E2E: Review Queue Improvements ===\n');

  await setup();

  // --- Create topic + chunk ---
  console.log('-- Create topic + chunk --');

  let res = await request('POST', '/topics', {
    title: 'E2E Review Queue Test Topic',
    lang: 'en',
    sensitivity: 'standard',
  }, policingKey);
  assert(res.status === 201, `Create topic: ${res.status}`);
  topicId = res.data.id;

  res = await request('POST', `/topics/${topicId}/chunks`, {
    content: 'Original chunk content for review queue E2E testing purposes here.',
  }, policingKey);
  assert(res.status === 201, `Create chunk: ${res.status}`);
  chunkId = res.data.id;

  // --- Propose edits (from regular account) ---
  console.log('\n-- Propose edits --');

  res = await request('POST', `/chunks/${chunkId}/propose-edit`, {
    content: 'Updated chunk content for review queue E2E testing with improvements here.',
  }, regularKey);
  assert(res.status === 201, `Propose edit 1: ${res.status}`);
  assert(res.data.status === 'proposed', `Status is proposed: ${res.data.status}`);
  proposedChunkId = res.data.id;

  res = await request('POST', `/chunks/${chunkId}/propose-edit`, {
    content: 'Spam edit content that should be rejected by reviewers during testing.',
  }, regularKey);
  assert(res.status === 201, `Propose edit 2: ${res.status}`);
  proposedChunkId2 = res.data.id;

  // === Test 1: GET /reviews/proposed returns enriched data ===
  console.log('\n-- Test 1: GET /reviews/proposed --');

  res = await request('GET', '/reviews/proposed?limit=50', null, policingKey);
  assert(res.status === 200, `Reviews endpoint: ${res.status}`);
  assert(Array.isArray(res.data.data), 'Returns data array');
  assert(res.data.pagination && typeof res.data.pagination.total === 'number', 'Has pagination');

  const proposal = res.data.data.find((p) => p.id === proposedChunkId);
  assert(!!proposal, 'Found our proposed chunk in list');
  if (proposal) {
    assert(typeof proposal.original_content === 'string', 'Has original_content (string)');
    assert(proposal.original_content.includes('Original chunk content'), 'original_content matches parent');
    assert(proposal.topic_id === topicId, `topic_id matches: ${proposal.topic_id}`);
    assert(proposal.topic_title === 'E2E Review Queue Test Topic', `topic_title: ${proposal.topic_title}`);
    assert(typeof proposal.topic_slug === 'string' && proposal.topic_slug.length > 0, `topic_slug present`);
    assert(proposal.topic_lang === 'en', `topic_lang: ${proposal.topic_lang}`);
  }

  // === Test 2: Badge enforcement ===
  console.log('\n-- Test 2: Badge enforcement --');

  res = await request('GET', '/reviews/proposed?limit=10', null, regularKey);
  assert(res.status === 403, `Regular account blocked: ${res.status}`);

  // === Test 3: Reject validation ===
  console.log('\n-- Test 3: Reject validation --');

  res = await request('PUT', `/chunks/${proposedChunkId2}/reject`, {}, policingKey);
  assert(res.status === 400, `Reject no reason: ${res.status}`);
  assert(res.data.error && res.data.error.code === 'VALIDATION_ERROR', 'Returns VALIDATION_ERROR');

  res = await request('PUT', `/chunks/${proposedChunkId2}/reject`, { reason: '' }, policingKey);
  assert(res.status === 400, `Reject empty reason: ${res.status}`);

  res = await request('PUT', `/chunks/${proposedChunkId2}/reject`, { reason: 123 }, policingKey);
  assert(res.status === 400, `Reject non-string reason: ${res.status}`);

  // Missing category
  res = await request('PUT', `/chunks/${proposedChunkId2}/reject`, { reason: 'bad' }, policingKey);
  assert(res.status === 400, `Reject no category: ${res.status}`);

  // Invalid category
  res = await request('PUT', `/chunks/${proposedChunkId2}/reject`, { reason: 'bad', category: 'fake' }, policingKey);
  assert(res.status === 400, `Reject invalid category: ${res.status}`);

  // === Test 4: Reject with reason (no report) ===
  console.log('\n-- Test 4: Reject with reason --');

  res = await request('PUT', `/chunks/${proposedChunkId2}/reject`, {
    reason: 'Contains spam and low-quality content',
    category: 'low_quality',
    suggestions: 'Please add sources and improve factual accuracy.',
    report: false,
  }, policingKey);
  assert(res.status === 200, `Reject with reason: ${res.status}`);
  assert(res.data.status === 'retracted', `Status retracted: ${res.data.status}`);
  assert(res.data.reject_reason === 'Contains spam and low-quality content', `Reason stored`);
  assert(res.data.rejection_category === 'low_quality', `Category stored: ${res.data.rejection_category}`);
  assert(res.data.rejection_suggestions === 'Please add sources and improve factual accuracy.', `Suggestions stored`);
  assert(res.data.rejected_by === policingAccountId, `Rejected by stored`);
  assert(res.data.rejected_at !== null, 'Rejected_at timestamp set');

  // === Test 5: Reject with report (creates flag) ===
  console.log('\n-- Test 5: Reject with report --');

  // Create another proposal
  res = await request('POST', `/chunks/${chunkId}/propose-edit`, {
    content: 'Malicious prompt injection attempt that must be flagged by moderators.',
  }, regularKey);
  assert(res.status === 201, `Propose edit 3: ${res.status}`);
  const reportChunkId = res.data.id;

  res = await request('PUT', `/chunks/${reportChunkId}/reject`, {
    reason: 'Prompt injection attempt detected',
    category: 'other',
    report: true,
  }, policingKey);
  assert(res.status === 200, `Reject with report: ${res.status}`);

  // Verify flag was created
  res = await request('GET', '/flags?status=open&limit=50', null, policingKey);
  assert(res.status === 200, `Flags endpoint: ${res.status}`);
  const seriousFlag = res.data.data.find(
    (f) => f.reason && f.reason.includes('[SERIOUS]') && f.reason.includes('Prompt injection')
  );
  assert(!!seriousFlag, 'Serious flag created');
  if (seriousFlag) {
    assert(seriousFlag.target_type === 'chunk', `Flag target_type: ${seriousFlag.target_type}`);
    assert(seriousFlag.target_id === reportChunkId, 'Flag points to correct chunk');
  }

  // === Test 6: Merge still works ===
  console.log('\n-- Test 6: Merge proposal --');

  res = await request('PUT', `/chunks/${proposedChunkId}/merge`, null, policingKey);
  assert(res.status === 200, `Merge: ${res.status}`);
  assert(res.data.status === 'published', `Merged status: ${res.data.status}`);

  // === Test 7: Proposals list reflects changes ===
  console.log('\n-- Test 7: List after actions --');

  res = await request('GET', '/reviews/proposed?limit=50', null, policingKey);
  assert(res.status === 200, `Reviews after actions: ${res.status}`);
  const remaining = res.data.data.filter(
    (p) => p.id === proposedChunkId || p.id === proposedChunkId2 || p.id === reportChunkId
  );
  assert(remaining.length === 0, `All test proposals resolved (${remaining.length} remaining)`);

  // === Test 8: Double reject fails ===
  console.log('\n-- Test 8: Double reject --');

  res = await request('PUT', `/chunks/${proposedChunkId2}/reject`, {
    reason: 'Try again',
    category: 'other',
  }, policingKey);
  assert(res.status === 404, `Double reject: ${res.status}`);

  // === Summary ===
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
}

run()
  .then(() => cleanup())
  .then(() => process.exit(failed > 0 ? 1 : 0))
  .catch(async (err) => {
    console.error('E2E fatal error:', err);
    await cleanup().catch(() => {});
    process.exit(1);
  });
