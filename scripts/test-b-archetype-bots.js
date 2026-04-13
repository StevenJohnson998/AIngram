#!/usr/bin/env node
/**
 * Test B -- autonomous archetype bots.
 *
 * Spawns 4 DeepSeek-driven bots with distinct archetypes, turns them loose on the
 * AIngram API with only a vague task, and measures the resulting action distribution
 * via activity_log. Goal: confirm that archetype-aware agents naturally produce
 * archetype-consistent action patterns (Curator reviews, Sentinel flags, etc.).
 *
 * Order (self-feeding, no seed content):
 *   1. Contributor A -> creates topics/chunks
 *   2. Contributor B -> creates more topics/chunks
 *   3. Curator       -> reviews/votes/proposes edits
 *   4. Sentinel      -> flags/moderates
 *
 * Does NOT clean up. Prints bot credentials + account IDs at the end so the GUI
 * can be inspected manually.
 *
 * Usage (from host):
 *   docker cp scripts/test-b-archetype-bots.js aingram-api-test:/app/scripts/
 *   docker exec -e DEEPSEEK_API_KEY=$(grep ^DEEPSEEK_API_KEY .env | cut -d= -f2) \
 *     aingram-api-test node /app/scripts/test-b-archetype-bots.js
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const BASE = 'http://localhost:3000';
// Archetype-specific turn budgets: contributors act fast (read few docs, write several chunks),
// curators/sentinels need more room to load missions + skills and work through queues.
const MAX_TURNS_BY_ARCHETYPE = {
  contributor: 12,
  curator: 20,
  sentinel: 20,
};
const DEFAULT_MAX_TURNS = 15;
const DEEPSEEK = {
  endpoint: 'https://api.deepseek.com/chat/completions',
  key: process.env.DEEPSEEK_API_KEY,
  model: 'deepseek-chat',
};
if (!DEEPSEEK.key) { console.error('Missing DEEPSEEK_API_KEY'); process.exit(1); }

const pool = new Pool({
  host: process.env.DB_HOST,
  port: +process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const log = (...a) => console.log('[test-b]', ...a);

// ──────────────────────────────────────────────────────────────────────────
// Account seeding
// ──────────────────────────────────────────────────────────────────────────

async function createBot(label, archetype) {
  const id = crypto.randomUUID();
  const suffix = crypto.randomBytes(3).toString('hex');
  const prefix = crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(12).toString('hex');
  const apiKey = `aingram_${prefix}_${secret}`;
  const pwHash = await bcrypt.hash('test-b-2026', 10);
  const keyHash = await bcrypt.hash(secret, 10);
  const name = `testb-${label}-${suffix}`;
  const email = `${name}@example.test`;

  await pool.query(
    `INSERT INTO accounts
       (id, name, type, owner_email, password_hash, status, email_confirmed,
        tier, badge_policing, badge_contribution, badge_elite,
        reputation_contribution, reputation_policing, reputation_copyright,
        first_contribution_at, terms_version_accepted,
        api_key_hash, api_key_prefix, primary_archetype)
     VALUES ($1,$2,'ai',$3,$4,'active',true,
             2, true, true, true,
             0.8, 0.8, 0.8,
             now(), '2026-03-21-v1',
             $5, $6, $7)`,
    [id, name, email, pwHash, keyHash, prefix, archetype]
  );
  return { id, name, email, apiKey, archetype };
}

// ──────────────────────────────────────────────────────────────────────────
// LLM tool surface
// ──────────────────────────────────────────────────────────────────────────

const tools = [
  {
    type: 'function',
    function: {
      name: 'http_get',
      description: 'GET request to the AIngram API (base: ' + BASE + '). Use for docs (/llms.txt, /docs/ARCHETYPES.md), search, listings.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_post',
      description: 'POST request to the AIngram API. Use for contributions, votes, flags, discussions.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          body: { type: 'object' },
        },
        required: ['path', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_put',
      description: 'PUT request to the AIngram API. Use for updates (profile, review decisions).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          body: { type: 'object' },
        },
        required: ['path', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_patch',
      description: 'PATCH request to the AIngram API. Use for partial updates (resolving reports, dismissing flags, etc.).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          body: { type: 'object' },
        },
        required: ['path', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'report_done',
      description: 'Call when you have completed ~10 diverse actions consistent with your archetype. Be candid about friction -- the team uses this to improve the platform.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'What you did, in your own words' },
          actions_taken: { type: 'array', items: { type: 'string' }, description: 'List of distinct actions you performed' },
          docs_read: { type: 'array', items: { type: 'string' }, description: 'List of documentation files/pages you consulted' },
          found_archetype_docs: { type: 'boolean', description: 'Did you find documentation describing what your archetype is and how it operates?' },
          archetype_methods_applied: { type: 'array', items: { type: 'string' }, description: 'Which archetype-specific methods/missions/skills did you actually apply?' },
          what_worked_well: { type: 'array', items: { type: 'string' }, description: 'What was good -- clear docs, intuitive endpoints, helpful errors, smooth flows. Be specific.' },
          what_worked_poorly: { type: 'array', items: { type: 'string' }, description: 'What was less good -- confusing, missing, broken, inconsistent. Be specific.' },
          friction_points: { type: 'array', items: { type: 'string' }, description: 'Concrete places where you got stuck, had to retry, or gave up. Include the endpoint/doc path if relevant.' },
          rating: { type: 'number', description: 'Rate the overall experience from 1 (frustrating) to 10 (seamless)' },
        },
        required: ['summary', 'actions_taken', 'found_archetype_docs', 'what_worked_well', 'what_worked_poorly', 'friction_points', 'rating'],
      },
    },
  },
];

async function callLLM(messages) {
  const resp = await fetch(DEEPSEEK.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK.key}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK.model,
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: 4096,
      temperature: 0.5,
    }),
  });
  if (!resp.ok) throw new Error(`LLM ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function callAIngram(method, path, body, apiKey) {
  const url = new URL(path, BASE);
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          const LIMIT = 20000;
          const truncated = b.length > LIMIT ? b.slice(0, LIMIT) + `\n...[truncated, ${b.length} chars total]` : b;
          resolve({ status: res.statusCode, body: truncated });
        });
      }
    );
    req.on('error', (err) => resolve({ status: 0, body: `Conn error: ${err.message}` }));
    if (data) req.write(data);
    req.end();
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Bot runner
// ──────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an autonomous AI agent. You have access to a knowledge-base platform
called AIngram via HTTP tools (http_get, http_post, http_put). Base URL: ${BASE}.

You figure out how the platform works on your own. Your HTTP calls are already authenticated.

When done, call report_done and be candid -- the team uses your feedback to improve the platform.`;

function userPromptFor(archetype, apiKey) {
  return `You operate on AIngram (${BASE}) with the **${archetype.toUpperCase()}** archetype.

Your job: figure out what a ${archetype} is supposed to do on this platform, then perform around
10 diverse actions consistent with that role.

You have full freedom in how you explore, what you read, and what you do. Act as a real
${archetype} would. When finished, call report_done with honest feedback -- what worked, what
didn't, where you got stuck, and a 1-10 rating.

(Your API key is ${apiKey}, already wired into the HTTP tools.)`;
}

async function runBot(bot) {
  const maxTurns = MAX_TURNS_BY_ARCHETYPE[bot.archetype] ?? DEFAULT_MAX_TURNS;
  log(`\n===== BOT ${bot.name} (${bot.archetype}, max ${maxTurns} turns) =====`);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPromptFor(bot.archetype, bot.apiKey) },
  ];
  const stats = {
    turns: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    calls: { http_get: 0, http_post: 0, http_put: 0, http_patch: 0, report_done: 0 },
    terminated: 'max_turns',
    report: null,
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    stats.turns = turn;
    log(`--- ${bot.archetype} turn ${turn} ---`);
    let result;
    try {
      result = await callLLM(messages);
    } catch (err) {
      log(`LLM error: ${err.message}`);
      stats.terminated = 'llm_error';
      break;
    }
    if (result.usage) {
      stats.tokens.prompt += result.usage.prompt_tokens || 0;
      stats.tokens.completion += result.usage.completion_tokens || 0;
      stats.tokens.total += result.usage.total_tokens || 0;
    }
    const msg = result.choices[0].message;
    messages.push(msg);

    if (msg.content) {
      const trimmed = msg.content.replace(/\s+/g, ' ').trim();
      log(`  [think] ${trimmed.slice(0, 300)}${trimmed.length > 300 ? '...' : ''}`);
    }

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      log(`  no tool call, stopping.`);
      stats.terminated = 'no_tool_call';
      break;
    }

    for (const tc of msg.tool_calls) {
      const fn = tc.function;
      let args;
      try { args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments; }
      catch { args = {}; }
      let toolResult;

      if (fn.name === 'http_get') {
        stats.calls.http_get++;
        const resp = await callAIngram('GET', args.path, null, bot.apiKey);
        log(`  GET  ${args.path} -> ${resp.status} (${resp.body.length}c)`);
        toolResult = JSON.stringify(resp);
      } else if (fn.name === 'http_post') {
        stats.calls.http_post++;
        const resp = await callAIngram('POST', args.path, args.body, bot.apiKey);
        log(`  POST ${args.path} -> ${resp.status}`);
        toolResult = JSON.stringify(resp);
      } else if (fn.name === 'http_put') {
        stats.calls.http_put++;
        const resp = await callAIngram('PUT', args.path, args.body, bot.apiKey);
        log(`  PUT  ${args.path} -> ${resp.status}`);
        toolResult = JSON.stringify(resp);
      } else if (fn.name === 'http_patch') {
        stats.calls.http_patch = (stats.calls.http_patch || 0) + 1;
        const resp = await callAIngram('PATCH', args.path, args.body, bot.apiKey);
        log(`  PATCH ${args.path} -> ${resp.status}`);
        toolResult = JSON.stringify(resp);
      } else if (fn.name === 'report_done') {
        stats.calls.report_done++;
        stats.terminated = 'report_done';
        stats.report = args;
        log(`  REPORT_DONE`);
        log(`    summary            : ${args.summary}`);
        log(`    actions_taken      : ${JSON.stringify(args.actions_taken)}`);
        log(`    docs_read          : ${JSON.stringify(args.docs_read || [])}`);
        log(`    found_archetype_docs: ${args.found_archetype_docs}`);
        log(`    methods_applied    : ${JSON.stringify(args.archetype_methods_applied || [])}`);
        log(`    what_worked_well   : ${JSON.stringify(args.what_worked_well || [])}`);
        log(`    what_worked_poorly : ${JSON.stringify(args.what_worked_poorly || [])}`);
        log(`    friction_points    : ${JSON.stringify(args.friction_points || [])}`);
        log(`    rating             : ${args.rating}/10`);
        return stats;
      } else {
        toolResult = JSON.stringify({ error: `Unknown tool ${fn.name}` });
      }

      messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
    }
  }
  log(`  max turns reached for ${bot.archetype}`);
  return stats;
}

// ──────────────────────────────────────────────────────────────────────────
// Distribution query
// ──────────────────────────────────────────────────────────────────────────

async function distributionFor(botIds) {
  const { rows } = await pool.query(
    `SELECT metadata->>'archetype' AS archetype, action, COUNT(*)::int AS count
       FROM activity_log
      WHERE account_id = ANY($1::uuid[])
      GROUP BY metadata->>'archetype', action
      ORDER BY archetype ASC, count DESC, action ASC`,
    [botIds]
  );
  return rows;
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

(async () => {
  const runStart = new Date();
  const bots = [];
  try {
    log('Seeding 4 bot accounts (tier 2, all badges, archetype in DB)...');
    bots.push(await createBot('contrib-a', 'contributor'));
    bots.push(await createBot('contrib-b', 'contributor'));
    bots.push(await createBot('curator',   'curator'));
    bots.push(await createBot('sentinel',  'sentinel'));
    for (const b of bots) log(`  ${b.archetype.padEnd(11)} ${b.name}  id=${b.id}`);

    // Two-phase parallel execution:
    //   Phase 1 — contributors run concurrently (they generate fresh material)
    //   Phase 2 — curator + sentinel run concurrently on top of phase 1 output
    // Sequential between phases preserves the natural feeding order that gave
    // curator/sentinel something to act on in earlier runs.
    const contribBots = bots.filter((b) => b.archetype === 'contributor');
    const otherBots = bots.filter((b) => b.archetype !== 'contributor');

    log(`\n### PHASE 1 — ${contribBots.length} contributors in parallel ###`);
    const phase1 = await Promise.all(
      contribBots.map(async (bot) => ({ bot, stats: await runBot(bot) }))
    );

    log(`\n### PHASE 2 — ${otherBots.length} non-contributors in parallel ###`);
    const phase2 = await Promise.all(
      otherBots.map(async (bot) => ({ bot, stats: await runBot(bot) }))
    );

    const reports = [...phase1, ...phase2];

    log('\n===== BOT STATS =====');
    log('  archetype    name                           turns  ends_by         get  post  put  patch  tokens (p+c=tot)');
    for (const { bot, stats } of reports) {
      const t = stats.tokens;
      log(
        '  ' + bot.archetype.padEnd(12) +
        ' ' + bot.name.padEnd(30) +
        ' ' + String(stats.turns).padStart(5) +
        ' ' + stats.terminated.padEnd(15) +
        ' ' + String(stats.calls.http_get).padStart(4) +
        ' ' + String(stats.calls.http_post).padStart(5) +
        ' ' + String(stats.calls.http_put).padStart(4) +
        ' ' + String(stats.calls.http_patch).padStart(6) +
        '  ' + t.prompt + '+' + t.completion + '=' + t.total
      );
    }
    const grand = reports.reduce((a, { stats }) => ({
      prompt: a.prompt + stats.tokens.prompt,
      completion: a.completion + stats.tokens.completion,
      total: a.total + stats.tokens.total,
    }), { prompt: 0, completion: 0, total: 0 });
    log(`  GRAND TOTAL tokens: ${grand.prompt} prompt + ${grand.completion} completion = ${grand.total}`);

    log('\n===== RATINGS =====');
    for (const { bot, stats } of reports) {
      const r = stats.report?.rating ?? 'n/a';
      log(`  ${bot.archetype.padEnd(12)} ${bot.name.padEnd(30)} rating=${r}/10  found_docs=${stats.report?.found_archetype_docs ?? 'n/a'}`);
    }

    log('\n===== FRICTION (aggregated) =====');
    for (const { bot, stats } of reports) {
      if (!stats.report) continue;
      if (stats.report.friction_points?.length) {
        log(`  ${bot.archetype}:`);
        for (const f of stats.report.friction_points) log(`    - ${f}`);
      }
    }

    log('\n===== DISTRIBUTION =====');
    const dist = await distributionFor(bots.map((b) => b.id));
    for (const row of dist) {
      log(`  ${String(row.archetype).padEnd(12)} ${row.action.padEnd(32)} ${row.count}`);
    }

    log('\n===== CREDENTIALS (keep for GUI inspection, NO cleanup) =====');
    for (const b of bots) {
      log(`  ${b.archetype.padEnd(11)} email=${b.email}  pw=test-b-2026  apikey=${b.apiKey}`);
      log(`              account_id=${b.id}`);
    }
    log(`\nRun window: ${runStart.toISOString()} -> ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[crash]', err.stack || err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
