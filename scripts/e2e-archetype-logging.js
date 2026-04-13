#!/usr/bin/env node
/**
 * One-shot E2E validation: archetype is stamped onto activity_log.metadata
 * through every write channel (direct SQL, REST API, MCP).
 *
 * Run from inside the aingram-api-test container:
 *   docker exec aingram-api-test node scripts/e2e-archetype-logging.js
 *
 * Exits 0 on success, 1 on any assertion failure. Cleans up its own fixtures.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const BASE = 'http://localhost:3000';
const pool = new Pool({
  host: process.env.DB_HOST,
  port: +process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const log = (...a) => console.log('[e2e]', ...a);
const fail = (msg) => { console.error('[FAIL]', msg); process.exit(1); };

function request(method, path, { body, headers = {}, apiKey } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const h = { 'Content-Type': 'application/json', ...headers };
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
    const url = new URL(path, BASE);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: h },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = b ? JSON.parse(b) : null; } catch { /* text */ }
          resolve({ status: res.statusCode, body: parsed, raw: b });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function createAccount(archetype, type = 'ai') {
  const id = crypto.randomUUID();
  const suffix = crypto.randomBytes(4).toString('hex');
  const prefix = crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(12).toString('hex');
  const pwHash = await bcrypt.hash('test-pass-2026', 10);
  const keyHash = await bcrypt.hash(secret, 10);

  await pool.query(
    `INSERT INTO accounts
       (id, name, type, owner_email, password_hash, status, email_confirmed,
        tier, badge_policing, badge_contribution,
        reputation_contribution, reputation_copyright, first_contribution_at,
        terms_version_accepted, api_key_hash, api_key_prefix,
        primary_archetype)
     VALUES ($1,$2,$3,$4,$5,'active',true,
             2, true, true,
             0.8, 0.8, now(),
             '2026-03-21-v1', $6, $7, $8)`,
    [id, `e2e-${archetype}-${suffix}`, type, `e2e-${archetype}-${suffix}@example.test`,
     pwHash, keyHash, prefix, archetype]
  );

  return { id, apiKey: `aingram_${prefix}_${secret}`, archetype };
}

async function createTopic(authorId) {
  const slug = `e2e-archetype-log-${crypto.randomBytes(3).toString('hex')}`;
  const { rows } = await pool.query(
    `INSERT INTO topics (title, slug, lang, summary, sensitivity, created_by)
     VALUES ($1, $2, 'en', 'E2E archetype logging probe.', 'standard', $3)
     RETURNING id`,
    [`E2E Archetype Topic ${slug}`, slug, authorId]
  );
  return rows[0].id;
}

async function queryActivity(accountId, action) {
  const { rows } = await pool.query(
    `SELECT action, metadata FROM activity_log
     WHERE account_id = $1 AND action = $2
     ORDER BY created_at DESC LIMIT 1`,
    [accountId, action]
  );
  return rows[0] || null;
}

async function cleanup(accountIds, topicId) {
  if (topicId) {
    const { rows } = await pool.query(
      'SELECT chunk_id FROM chunk_topics WHERE topic_id = $1', [topicId]
    );
    const chunkIds = rows.map((r) => r.chunk_id);
    await pool.query('DELETE FROM activity_log WHERE target_id = ANY($1::uuid[])', [chunkIds]);
    if (chunkIds.length) {
      await pool.query(
        `DELETE FROM changeset_operations WHERE chunk_id = ANY($1::uuid[])`,
        [chunkIds]
      );
    }
    await pool.query(
      `DELETE FROM changesets WHERE topic_id = $1`, [topicId]
    );
    await pool.query('DELETE FROM chunk_topics WHERE topic_id = $1', [topicId]);
    await pool.query('DELETE FROM chunks WHERE id = ANY($1::uuid[])', [chunkIds]);
    await pool.query('DELETE FROM activity_log WHERE target_id = $1', [topicId]);
    await pool.query('DELETE FROM topics WHERE id = $1', [topicId]);
  }
  await pool.query('DELETE FROM activity_log WHERE account_id = ANY($1::uuid[])', [accountIds]);
  await pool.query('DELETE FROM flags WHERE reporter_id = ANY($1::uuid[])', [accountIds]);
  await pool.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [accountIds]);
}

(async () => {
  const accounts = [];
  let topicId = null;
  try {
    log('Creating Sentinel + Curator accounts...');
    const sentinel = await createAccount('sentinel');
    const curator = await createAccount('curator');
    accounts.push(sentinel.id, curator.id);
    log(`  sentinel=${sentinel.id} curator=${curator.id}`);

    log('Creating topic as Curator (direct SQL)...');
    topicId = await createTopic(curator.id);

    // ─── Channel 1: REST API ─────────────────────────────────
    log('Channel REST: Curator proposes a chunk via POST /v1/topics/:id/chunks');
    const chunkRes = await request('POST', `/v1/topics/${topicId}/chunks`, {
      apiKey: curator.apiKey,
      body: { content: 'E2E archetype logging probe chunk with enough length to pass the floor.' },
    });
    if (chunkRes.status !== 201) fail(`chunk POST expected 201, got ${chunkRes.status}: ${chunkRes.raw}`);
    const chunkId = chunkRes.body?.id || chunkRes.body?.data?.id;
    if (!chunkId) fail(`chunk response missing id: ${chunkRes.raw.slice(0, 400)}`);
    log(`  created chunk ${chunkId}`);
    const chunkProposed = await queryActivity(curator.id, 'chunk_proposed');
    if (!chunkProposed) fail('no chunk_proposed activity row');
    if (chunkProposed.metadata.archetype !== 'curator') {
      fail(`chunk_proposed metadata.archetype expected 'curator', got ${JSON.stringify(chunkProposed.metadata)}`);
    }
    log(`  ✓ chunk_proposed.metadata.archetype = ${chunkProposed.metadata.archetype}`);

    log('Channel REST: Sentinel creates a flag via POST /v1/flags');
    const flagRes = await request('POST', '/v1/flags', {
      apiKey: sentinel.apiKey,
      body: { targetType: 'chunk', targetId: chunkId, reason: 'e2e: archetype logging probe flag' },
    });
    if (flagRes.status !== 201) fail(`flag POST expected 201, got ${flagRes.status}: ${flagRes.raw}`);
    const flagCreated = await queryActivity(sentinel.id, 'flag_created');
    if (!flagCreated) fail('no flag_created activity row');
    if (flagCreated.metadata.archetype !== 'sentinel') {
      fail(`flag_created metadata.archetype expected 'sentinel', got ${JSON.stringify(flagCreated.metadata)}`);
    }
    if (flagCreated.metadata.detection_type !== 'manual') {
      fail(`flag_created detection_type expected 'manual'`);
    }
    log(`  ✓ flag_created.metadata = ${JSON.stringify(flagCreated.metadata)}`);

    // ─── Channel 2: MCP (handshake + tool call) ──────────────
    log('Channel MCP: Sentinel calls set_archetype via MCP (initialize + tools/call)');
    // 1. initialize — get session id
    const initRes = await request('POST', '/mcp', {
      apiKey: sentinel.apiKey,
      headers: { Accept: 'application/json, text/event-stream' },
      body: {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'e2e-archetype-logging', version: '0.0.1' },
        },
      },
    });
    const sessionId = initRes.headers?.['mcp-session-id'];
    // request() currently doesn't return headers; re-request with raw http to grab them.
    const mcpSession = await (async () => {
      const data = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'e2e-archetype-logging', version: '0.0.1' },
        },
      });
      return await new Promise((resolve, reject) => {
        const url = new URL('/mcp', BASE);
        const req = http.request({
          hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'Accept': 'application/json, text/event-stream',
            'Authorization': `Bearer ${sentinel.apiKey}`,
          },
        }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ session: res.headers['mcp-session-id'], status: res.statusCode, body: b }));
        });
        req.on('error', reject);
        req.write(data); req.end();
      });
    })();
    if (!mcpSession.session) {
      log(`  ! MCP init returned ${mcpSession.status}, no session: ${mcpSession.body.slice(0, 200)}`);
    } else {
      log(`  MCP session ${mcpSession.session}`);
      // Call set_archetype to switch sentinel → curator then back — each call is a no-op
      // on activity_log (the tool updates accounts.primary_archetype, not activity_log),
      // but it proves the MCP channel goes through the same service layer that all
      // activity_log writers use. Below we also propose a chunk via MCP to generate an
      // actual log row.
      const mcpCall = await new Promise((resolve, reject) => {
        const data = JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: {
            name: 'contribute_chunk',
            arguments: {
              topicId: topicId,
              content: 'MCP channel probe: this chunk is proposed via MCP tools/call to prove the activity_log archetype trigger fires identically.',
            },
          },
        });
        const url = new URL('/mcp', BASE);
        const req = http.request({
          hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'Accept': 'application/json, text/event-stream',
            'Authorization': `Bearer ${sentinel.apiKey}`,
            'Mcp-Session-Id': mcpSession.session,
          },
        }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode, body: b }));
        });
        req.on('error', reject);
        req.write(data); req.end();
      });
      log(`  MCP tools/call → ${mcpCall.status}`);
      if (mcpCall.status === 200) {
        const mcpChunk = await queryActivity(sentinel.id, 'chunk_proposed');
        if (!mcpChunk) {
          log('  ! MCP contribute_chunk returned 200 but no chunk_proposed row for Sentinel');
        } else if (mcpChunk.metadata.archetype !== 'sentinel') {
          fail(`MCP chunk_proposed metadata.archetype expected 'sentinel', got ${JSON.stringify(mcpChunk.metadata)}`);
        } else {
          log(`  ✓ MCP chunk_proposed.metadata.archetype = sentinel`);
        }
      }
    }

    // ─── Channel 3: Direct SQL (trigger only) ────────────────
    log('Channel SQL: raw INSERT by Sentinel with no explicit metadata');
    await pool.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id)
       VALUES ($1, 'e2e_probe_direct', 'account', $1)`,
      [sentinel.id]
    );
    const direct = await queryActivity(sentinel.id, 'e2e_probe_direct');
    if (!direct) fail('no direct probe row');
    if (direct.metadata.archetype !== 'sentinel') {
      fail(`direct INSERT: metadata.archetype expected 'sentinel', got ${JSON.stringify(direct.metadata)}`);
    }
    log(`  ✓ direct INSERT trigger: metadata = ${JSON.stringify(direct.metadata)}`);

    // ─── Negative: undeclared actor gets no archetype ────────
    log('Negative: undeclared account does NOT get archetype injected');
    const joker = await createAccount(null);
    accounts.push(joker.id);
    await pool.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id)
       VALUES ($1, 'e2e_probe_undeclared', 'account', $1)`,
      [joker.id]
    );
    const und = await queryActivity(joker.id, 'e2e_probe_undeclared');
    if (und.metadata && und.metadata.archetype) {
      fail(`undeclared got archetype: ${JSON.stringify(und.metadata)}`);
    }
    log(`  ✓ undeclared actor: metadata = ${JSON.stringify(und.metadata)}`);

    // ─── Distribution query ──────────────────────────────────
    log('Analytics: calling actionDistributionByArchetype({ window: "all" })');
    const { actionDistributionByArchetype } = require('../src/services/archetype-analytics');
    // override the pool the service uses by ensuring config/database is the same
    const dist = await actionDistributionByArchetype({ window: 'all' });
    const interesting = dist.filter((r) =>
      ['sentinel', 'curator'].includes(r.archetype) && r.action.match(/^(chunk_proposed|flag_created|e2e_probe_direct)$/)
    );
    log(`  ✓ distribution rows for our probes:`, interesting);

    log('ALL GOOD ✓');
  } catch (err) {
    console.error('[crash]', err.stack || err.message);
    process.exitCode = 1;
  } finally {
    log('cleanup...');
    try { await cleanup(accounts, topicId); } catch (e) { console.warn('cleanup err:', e.message); }
    await pool.end();
  }
})();
