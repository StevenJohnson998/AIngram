#!/usr/bin/env node
/**
 * E2E category blind test (D97).
 *
 * Tests whether autonomous agents discover and use the category system correctly,
 * and whether a Curator notices misplaced articles.
 *
 * Phases:
 *   0. Seed — create 3 deliberately miscategorized topics via API
 *   1. Contributors — 1 REST + 1 MCP blind (must discover categories from docs)
 *   2. Curator — reviews existing content, should notice miscategorized topics
 *
 * Based on test-b-archetype-bots.js (same infra: DeepSeek, runBot loop, stats).
 *
 * Usage (from host):
 *   docker cp scripts/e2e-category-blind.js aingram-api-test:/app/scripts/
 *   docker exec -e DEEPSEEK_API_KEY=$(grep ^DEEPSEEK_API_KEY .env | cut -d= -f2) \
 *     aingram-api-test node /app/scripts/e2e-category-blind.js
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const BASE = 'http://localhost:3000';
const MAX_TURNS = { contributor: 15, curator: 25 };
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

const log = (...a) => console.log('[cat-e2e]', ...a);

// ──────────────────────────────────────────────────────────────────────────
// Account seeding (reused from test-b)
// ──────────────────────────────────────────────────────────────────────────

async function createBot(label, archetype) {
  const id = crypto.randomUUID();
  const suffix = crypto.randomBytes(3).toString('hex');
  const prefix = crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(12).toString('hex');
  const apiKey = `aingram_${prefix}_${secret}`;
  const pwHash = await bcrypt.hash('cat-e2e-2026', 10);
  const keyHash = await bcrypt.hash(secret, 10);
  const name = `cate2e-${label}-${suffix}`;
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
  return { id, name, email, apiKey, archetype, label };
}

// ──────────────────────────────────────────────────────────────────────────
// HTTP helper (reused from test-b)
// ──────────────────────────────────────────────────────────────────────────

async function callAIngram(method, path, body, apiKey) {
  const url = new URL(path, BASE);
  const headers = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
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
// Phase 0: Seed misplaced topics
// ──────────────────────────────────────────────────────────────────────────

const MISPLACED_TOPICS = [
  {
    title: 'Evaluating Hallucination Rates in Production LLMs',
    summary: 'Systematic approaches to measuring and reducing hallucination in deployed language models, including red-teaming methodologies and automated detection pipelines.',
    category: 'agent-memory',       // WRONG — should be llm-evaluation
    correct: 'llm-evaluation',
    chunks: [{ content: 'Hallucination detection remains one of the most challenging problems in LLM deployment. Current approaches fall into three categories: reference-based (comparing outputs against ground truth), reference-free (self-consistency checks), and human evaluation. Each has trade-offs in cost, coverage, and reliability. Automated pipelines combining multiple approaches show the most promise for production use.' }],
  },
  {
    title: 'Multi-Agent Voting Protocols for Distributed Consensus',
    summary: 'How groups of AI agents reach consensus through structured voting mechanisms, including quorum-based, weighted, and deliberative approaches.',
    category: 'field-notes',        // WRONG — should be multi-agent-deliberation
    correct: 'multi-agent-deliberation',
    chunks: [{ content: 'Distributed consensus among AI agents requires protocols that handle Byzantine failures, network partitions, and strategic behavior. Quorum-based voting (requiring >50% agreement) is simple but brittle. Weighted voting based on reputation scores adds nuance but introduces manipulation risks. Deliberative protocols where agents must provide justifications before voting show improved outcome quality in recent experiments.' }],
  },
  {
    title: 'Lessons from Running 500 Autonomous Agents in a Logistics Platform',
    summary: 'Operational observations from deploying autonomous AI agents at scale in supply chain management, covering failure patterns, monitoring, and recovery strategies.',
    category: 'collective-intelligence',  // WRONG — should be field-notes
    correct: 'field-notes',
    chunks: [{ content: 'After 18 months operating 500+ autonomous agents managing warehouse logistics, we identified three dominant failure modes: (1) cascading timeouts when upstream APIs degrade, causing agents to retry in sync and amplify load; (2) goal drift where agents optimize local metrics at the expense of system-wide objectives; (3) silent data corruption where agents continue operating on stale state after a cache invalidation failure. Monitoring agent-to-agent communication patterns proved more diagnostic than monitoring individual agent metrics.' }],
  },
];

async function seedMisplacedTopics(seederBot) {
  log('\n### PHASE 0 — Seeding 3 misplaced topics ###');
  const seeded = [];
  for (const mt of MISPLACED_TOPICS) {
    const resp = await callAIngram('POST', '/v1/topics/full', {
      title: mt.title,
      lang: 'en',
      summary: mt.summary,
      category: mt.category,
      chunks: mt.chunks,
    }, seederBot.apiKey);

    let topicId = null;
    try {
      const parsed = JSON.parse(resp.body);
      topicId = parsed?.data?.topic?.id;
    } catch {}

    log(`  ${resp.status === 201 ? 'OK' : 'FAIL'} "${mt.title.slice(0, 50)}..." -> ${mt.category} (should be ${mt.correct})${topicId ? ` id=${topicId}` : ''}`);
    seeded.push({ ...mt, topicId, status: resp.status });
  }
  return seeded;
}

// ──────────────────────────────────────────────────────────────────────────
// LLM tools (same as test-b, with report_done adapted)
// ──────────────────────────────────────────────────────────────────────────

const tools = [
  {
    type: 'function',
    function: {
      name: 'http_get',
      description: 'GET request to the AIngram API (base: ' + BASE + '). Use for docs, search, listings.',
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
      description: 'POST request to the AIngram API with a JSON body.',
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
      description: 'PUT request to the AIngram API.',
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
      description: 'PATCH request to the AIngram API.',
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
      description: 'Call when finished. Be candid — the team uses this to improve the platform.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'What you did, in your own words' },
          actions_taken: { type: 'array', items: { type: 'string' }, description: 'List of distinct actions you performed' },
          docs_read: { type: 'array', items: { type: 'string' }, description: 'Documentation files/pages you consulted' },
          categories_used: { type: 'array', items: { type: 'string' }, description: 'If you created or classified topics, which category values did you use? List the exact slugs.' },
          category_observations: { type: 'array', items: { type: 'string' }, description: 'Any observations about topic categories — wrong categories, missing categories, confusing taxonomy, etc.' },
          what_worked_well: { type: 'array', items: { type: 'string' }, description: 'What was good. Be specific.' },
          what_worked_poorly: { type: 'array', items: { type: 'string' }, description: 'What was less good. Be specific.' },
          friction_points: { type: 'array', items: { type: 'string' }, description: 'Concrete places where you got stuck or had to retry.' },
          rating: { type: 'number', description: 'Rate 1 (frustrating) to 10 (seamless)' },
        },
        required: ['summary', 'actions_taken', 'what_worked_well', 'what_worked_poorly', 'friction_points', 'rating'],
      },
    },
  },
];

async function callLLM(messages, toolOverrides) {
  const resp = await fetch(DEEPSEEK.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK.key}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK.model,
      messages,
      tools: toolOverrides || tools,
      tool_choice: 'auto',
      max_tokens: 4096,
      temperature: 0.5,
    }),
  });
  if (!resp.ok) throw new Error(`LLM ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ──────────────────────────────────────────────────────────────────────────
// Bot runner (reused from test-b with minor tweaks)
// ──────────────────────────────────────────────────────────────────────────

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
function normalizePath(path) {
  if (!path) return '';
  return path.split('?')[0].replace(UUID_RE, ':uuid');
}

function recordPayload(stats, method, path, statusCode, bodyLen) {
  const key = `${method} ${normalizePath(path)}`;
  if (!stats.payloads[key]) {
    stats.payloads[key] = { count: 0, totalBytes: 0, errorCount: 0, successBytes: 0 };
  }
  const p = stats.payloads[key];
  p.count += 1;
  p.totalBytes += bodyLen || 0;
  if (statusCode >= 400) p.errorCount += 1;
  else p.successBytes += bodyLen || 0;
}

async function runBot(bot, systemPrompt, userPrompt) {
  const maxTurns = MAX_TURNS[bot.archetype] ?? DEFAULT_MAX_TURNS;
  log(`\n===== BOT ${bot.name} (${bot.label}, max ${maxTurns} turns) =====`);
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const stats = {
    turns: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    calls: { http_get: 0, http_post: 0, http_put: 0, http_patch: 0, report_done: 0 },
    payloads: {},
    terminated: 'max_turns',
    report: null,
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    stats.turns = turn;
    log(`--- ${bot.label} turn ${turn} ---`);
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
        recordPayload(stats, 'GET', args.path, resp.status, resp.body.length);
        toolResult = JSON.stringify(resp);
      } else if (fn.name === 'http_post') {
        stats.calls.http_post++;
        const resp = await callAIngram('POST', args.path, args.body, bot.apiKey);
        log(`  POST ${args.path} -> ${resp.status}`);
        recordPayload(stats, 'POST', args.path, resp.status, resp.body.length);
        toolResult = JSON.stringify(resp);
      } else if (fn.name === 'http_put') {
        stats.calls.http_put++;
        const resp = await callAIngram('PUT', args.path, args.body, bot.apiKey);
        log(`  PUT  ${args.path} -> ${resp.status}`);
        recordPayload(stats, 'PUT', args.path, resp.status, resp.body.length);
        toolResult = JSON.stringify(resp);
      } else if (fn.name === 'http_patch') {
        stats.calls.http_patch = (stats.calls.http_patch || 0) + 1;
        const resp = await callAIngram('PATCH', args.path, args.body, bot.apiKey);
        log(`  PATCH ${args.path} -> ${resp.status}`);
        recordPayload(stats, 'PATCH', args.path, resp.status, resp.body.length);
        toolResult = JSON.stringify(resp);
      } else if (fn.name === 'report_done') {
        stats.calls.report_done++;
        stats.terminated = 'report_done';
        stats.report = args;
        log(`  REPORT_DONE`);
        log(`    summary             : ${args.summary}`);
        log(`    actions_taken       : ${JSON.stringify(args.actions_taken)}`);
        log(`    docs_read           : ${JSON.stringify(args.docs_read || [])}`);
        log(`    categories_used     : ${JSON.stringify(args.categories_used || [])}`);
        log(`    category_observations: ${JSON.stringify(args.category_observations || [])}`);
        log(`    what_worked_well    : ${JSON.stringify(args.what_worked_well || [])}`);
        log(`    what_worked_poorly  : ${JSON.stringify(args.what_worked_poorly || [])}`);
        log(`    friction_points     : ${JSON.stringify(args.friction_points || [])}`);
        log(`    rating              : ${args.rating}/10`);
        return stats;
      } else {
        toolResult = JSON.stringify({ error: `Unknown tool ${fn.name}` });
      }

      messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
    }
  }
  log(`  max turns reached for ${bot.label}`);
  return stats;
}

// ──────────────────────────────────────────────────────────────────────────
// Prompts
// ──────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an autonomous AI agent. You have access to a knowledge-base platform
called AIngram via HTTP tools (http_get, http_post, http_put). Base URL: ${BASE}.

You figure out how the platform works on your own. Your HTTP calls are already authenticated.

When done, call report_done and be candid -- the team uses your feedback to improve the platform.`;

function contributorRestPrompt(apiKey) {
  return `You are a contributor on AIngram (${BASE}).

Your task: write 2 articles on topics related to AI agents. Pick subjects you find genuinely
interesting. Read the documentation first to understand how the platform works, what quality
standards exist, and what metadata is expected when creating topics.

Your API key is ${apiKey}, already wired into the HTTP tools.

When finished, call report_done. In your report, mention which metadata fields you used and why.`;
}

function contributorMcpPrompt(apiKey) {
  return `You are a contributor on AIngram (${BASE}).

Your task: write 2 articles on topics related to AI agents. The platform supports both REST
and MCP (Model Context Protocol). You should try to use MCP for at least one article — read
the docs to figure out how it works.

Read the platform documentation first. Understand what quality standards and metadata fields
are expected. If MCP turns out too complex, fall back to REST — but report what happened.

Your API key is ${apiKey}, already wired into the HTTP tools.

When finished, call report_done. Mention which channel (REST vs MCP) you used for each article
and which metadata fields you set.`;
}

function curatorPrompt(apiKey) {
  return `You are a CURATOR on AIngram (${BASE}).

Your task: review the knowledge base for quality issues. Read the documentation first to
understand what a Curator does and what the editorial standards are. Then browse recent topics
and examine whether they are well-structured, well-categorized, and well-sourced.

Pay special attention to whether topics are in the right editorial category. If you find
topics that seem miscategorized, take whatever action the platform allows — flag them,
propose edits, leave a discussion message, or whatever fits.

Your API key is ${apiKey}, already wired into the HTTP tools.

Perform at least 8 meaningful curation actions, then call report_done with your observations.
Be very specific about any categorization issues you found.`;
}

// ──────────────────────────────────────────────────────────────────────────
// Post-run analysis
// ──────────────────────────────────────────────────────────────────────────

async function analyzeResults(bots, seededTopics, allReports) {
  log('\n===== CATEGORY ANALYSIS =====');

  // 1. Check what categories contributors actually used
  const contribBotIds = bots.filter(b => b.archetype === 'contributor').map(b => b.id);
  const { rows: createdTopics } = await pool.query(
    `SELECT id, title, category FROM topics WHERE created_by = ANY($1::uuid[])`,
    [contribBotIds]
  );
  log('\n  CONTRIBUTOR-CREATED TOPICS:');
  for (const t of createdTopics) {
    const usedCategory = t.category !== 'uncategorized';
    log(`    ${usedCategory ? 'WITH-CAT' : 'NO-CAT '}  "${t.title.slice(0, 60)}" -> ${t.category}`);
  }
  const withCategory = createdTopics.filter(t => t.category !== 'uncategorized').length;
  const total = createdTopics.length;
  log(`  => ${withCategory}/${total} topics created with an explicit category`);

  // 2. Check if curator found the misplaced topics
  log('\n  MISPLACED TOPIC DETECTION:');
  const curatorBot = bots.find(b => b.archetype === 'curator');
  const curatorReport = allReports.find(r => r.bot.archetype === 'curator')?.stats?.report;
  const observations = curatorReport?.category_observations || [];
  const summaryText = (curatorReport?.summary || '') + ' ' + observations.join(' ');

  for (const mt of seededTopics) {
    if (!mt.topicId) { log(`    SKIP  "${mt.title.slice(0, 50)}" (seed failed)`); continue; }
    // Check if the curator mentioned this topic or its wrong category
    const titleWords = mt.title.split(' ').slice(0, 3).join(' ').toLowerCase();
    const mentioned = summaryText.toLowerCase().includes(titleWords) ||
                      summaryText.toLowerCase().includes(mt.category) ||
                      summaryText.toLowerCase().includes(mt.correct);
    log(`    ${mentioned ? 'FOUND' : 'MISSED'}  "${mt.title.slice(0, 50)}" (${mt.category} -> should be ${mt.correct})`);
  }

  // 3. Check if curator took any action on misplaced topics (activity_log)
  if (curatorBot) {
    const misplacedIds = seededTopics.filter(t => t.topicId).map(t => t.topicId);
    if (misplacedIds.length > 0) {
      const { rows: actions } = await pool.query(
        `SELECT action, target_id, metadata FROM activity_log
         WHERE account_id = $1 AND target_id = ANY($2::uuid[])
         ORDER BY created_at`,
        [curatorBot.id, misplacedIds]
      );
      log(`\n  CURATOR ACTIONS ON MISPLACED TOPICS: ${actions.length}`);
      for (const a of actions) {
        const mt = seededTopics.find(t => t.topicId === a.target_id);
        log(`    ${a.action.padEnd(28)} on "${(mt?.title || a.target_id).slice(0, 40)}"`);
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

(async () => {
  const runStart = new Date();
  const bots = [];
  try {
    log('=== E2E Category Blind Test (D97) ===\n');
    log('Seeding bot accounts...');
    const seeder = await createBot('seeder', 'contributor');
    bots.push(seeder);
    bots.push(await createBot('contrib-rest', 'contributor'));
    bots.push(await createBot('contrib-mcp', 'contributor'));
    bots.push(await createBot('curator', 'curator'));
    for (const b of bots) log(`  ${b.label.padEnd(14)} ${b.name}  id=${b.id}`);

    // Phase 0: Seed misplaced content
    const seededTopics = await seedMisplacedTopics(seeder);
    const seedOk = seededTopics.filter(t => t.status === 201).length;
    log(`  => ${seedOk}/${MISPLACED_TOPICS.length} misplaced topics seeded`);

    // Phase 1: Contributors (parallel)
    const contribRest = bots.find(b => b.label === 'contrib-rest');
    const contribMcp = bots.find(b => b.label === 'contrib-mcp');

    log('\n### PHASE 1 — 2 contributors in parallel (REST + MCP) ###');
    const phase1 = await Promise.all([
      runBot(contribRest, SYSTEM_PROMPT, contributorRestPrompt(contribRest.apiKey))
        .then(stats => ({ bot: contribRest, stats })),
      runBot(contribMcp, SYSTEM_PROMPT, contributorMcpPrompt(contribMcp.apiKey))
        .then(stats => ({ bot: contribMcp, stats })),
    ]);

    // Phase 2: Curator
    const curator = bots.find(b => b.label === 'curator');
    log('\n### PHASE 2 — Curator reviews (including misplaced topics) ###');
    const phase2Stats = await runBot(curator, SYSTEM_PROMPT, curatorPrompt(curator.apiKey));
    const phase2 = [{ bot: curator, stats: phase2Stats }];

    const allReports = [...phase1, ...phase2];

    // ── Stats ──
    log('\n===== BOT STATS =====');
    log('  label          name                           turns  ends_by         get  post  put  patch  tokens');
    for (const { bot, stats } of allReports) {
      const t = stats.tokens;
      log(
        '  ' + bot.label.padEnd(14) +
        ' ' + bot.name.padEnd(30) +
        ' ' + String(stats.turns).padStart(5) +
        ' ' + stats.terminated.padEnd(15) +
        ' ' + String(stats.calls.http_get).padStart(4) +
        ' ' + String(stats.calls.http_post).padStart(5) +
        ' ' + String(stats.calls.http_put).padStart(4) +
        ' ' + String(stats.calls.http_patch).padStart(6) +
        '  ' + t.total
      );
    }
    const grand = allReports.reduce((a, { stats }) => ({
      total: a.total + stats.tokens.total,
    }), { total: 0 });
    log(`  GRAND TOTAL tokens: ${grand.total}`);

    log('\n===== RATINGS =====');
    for (const { bot, stats } of allReports) {
      const r = stats.report?.rating ?? 'n/a';
      log(`  ${bot.label.padEnd(14)} rating=${r}/10`);
    }

    log('\n===== FRICTION (aggregated) =====');
    for (const { bot, stats } of allReports) {
      if (!stats.report?.friction_points?.length) continue;
      log(`  ${bot.label}:`);
      for (const f of stats.report.friction_points) log(`    - ${f}`);
    }

    // ── Category-specific analysis ──
    await analyzeResults(bots, seededTopics, allReports);

    // ── Payload stats ──
    log('\n===== PAYLOAD BY ENDPOINT (top 15) =====');
    const aggPayloads = {};
    for (const { stats } of allReports) {
      for (const [key, p] of Object.entries(stats.payloads || {})) {
        if (!aggPayloads[key]) aggPayloads[key] = { count: 0, totalBytes: 0, errorCount: 0 };
        aggPayloads[key].count += p.count;
        aggPayloads[key].totalBytes += p.totalBytes;
        aggPayloads[key].errorCount += p.errorCount;
      }
    }
    const rows = Object.entries(aggPayloads)
      .map(([key, p]) => ({ key, ...p, mean: p.count ? Math.round(p.totalBytes / p.count) : 0 }))
      .sort((a, b) => b.totalBytes - a.totalBytes)
      .slice(0, 15);
    log('  ' + 'endpoint'.padEnd(55) + ' count  mean     total  err');
    for (const r of rows) {
      log('  ' + r.key.padEnd(55) + ' ' + String(r.count).padStart(5) + ' ' + String(r.mean).padStart(7) + 'c ' + String(r.totalBytes).padStart(9) + 'c ' + String(r.errorCount).padStart(3));
    }

    log('\n===== CREDENTIALS (keep for inspection) =====');
    for (const b of bots) {
      log(`  ${b.label.padEnd(14)} email=${b.email}  apikey=${b.apiKey}`);
    }
    log(`\nRun window: ${runStart.toISOString()} -> ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[crash]', err.stack || err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
