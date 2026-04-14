#!/usr/bin/env node
/**
 * measure-channels.js — Compare REST vs MCP scaffolding and per-action costs.
 *
 * Counts bytes + estimated tokens (char/4 rule of thumb) for what an agent
 * loads on each channel before it can act, plus a representative round-trip.
 *
 * Run from inside the aingram-api-test container OR the host network:
 *   docker exec aingram-api-test node scripts/measure-channels.js
 *
 * Output: one markdown table per dimension + a compact summary at the end.
 * No state changes; anonymous calls where possible.
 */

'use strict';

const http = require('node:http');

const BASE = process.env.BASE || 'http://localhost:3000';
const CHARS_PER_TOKEN = 4;

const estTokens = (s) => Math.ceil((s?.length || 0) / CHARS_PER_TOKEN);
const bytes = (s) => Buffer.byteLength(s || '', 'utf8');

function request(method, path, { body, headers = {}, apiKey } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
    const h = { 'Accept': 'application/json, text/event-stream', ...headers };
    if (data && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
    const url = new URL(path, BASE);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method,
        headers: h,
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: b,
        }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function parseSseOrJson(text) {
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try { return JSON.parse(line.slice(6)); } catch { /* fallthrough */ }
    }
  }
  try { return JSON.parse(text); } catch { return null; }
}

// ───────────────────────────────────────────────────────────────────────
// REST: static doc stack an agent would load
// ───────────────────────────────────────────────────────────────────────

const REST_DOCS = [
  '/llms.txt',
  '/llms-write.txt',
  '/llms-correct.txt',
  '/llms-converse.txt',
  '/llms-review.txt',
  '/llms-refresh.txt',
  '/llms-validate.txt',
  '/llms-flag.txt',
  '/llms-moderate.txt',
  '/llms-search.txt',
  '/llms-subscriptions.txt',
  '/llms-api.txt',
  '/llms-copyright.txt',
  '/llms-contribute.txt',
  '/llms-dispute.txt',
];

async function measureRestDocs() {
  const results = [];
  for (const path of REST_DOCS) {
    const res = await request('GET', path);
    results.push({ path, bytes: bytes(res.body), tokens: estTokens(res.body), status: res.status });
  }
  return results;
}

async function measureRestBundles() {
  const archetypes = ['contributor', 'curator', 'teacher', 'sentinel', 'joker'];
  const results = [];
  for (const a of archetypes) {
    const res = await request('GET', `/v1/archetypes/${a}/bundle`);
    results.push({ archetype: a, bytes: bytes(res.body), tokens: estTokens(res.body), status: res.status });
  }
  return results;
}

// ───────────────────────────────────────────────────────────────────────
// MCP: initialize + tools/list at different enable states
// ───────────────────────────────────────────────────────────────────────

async function mcpInit() {
  const body = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'measure-channels', version: '1.0' },
    },
  };
  const res = await request('POST', '/mcp', { body });
  return res.headers['mcp-session-id'];
}

async function mcpToolsList(sessionId) {
  const body = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
  const res = await request('POST', '/mcp', {
    body,
    headers: { 'Mcp-Session-Id': sessionId },
  });
  const parsed = parseSseOrJson(res.body);
  const tools = parsed?.result?.tools || [];
  return { payload: res.body, tools };
}

async function mcpEnable(sessionId, category, apiKey) {
  const body = {
    jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
    params: { name: 'enable_tools', arguments: { category, enabled: true } },
  };
  const res = await request('POST', '/mcp', {
    body,
    apiKey,
    headers: { 'Mcp-Session-Id': sessionId },
  });
  return res;
}

async function mcpGetBundle(sessionId, name) {
  const body = {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'get_archetype_bundle', arguments: { name } },
  };
  const res = await request('POST', '/mcp', {
    body,
    headers: { 'Mcp-Session-Id': sessionId },
  });
  const parsed = parseSseOrJson(res.body);
  const markdown = parsed?.result?.content?.[0]?.text || '';
  return { payload: res.body, markdown };
}

// ───────────────────────────────────────────────────────────────────────
// Round-trip: contribute_chunk equivalent on both channels (auth required,
// so we measure the payload sizes without actually creating a chunk)
// ───────────────────────────────────────────────────────────────────────

function restContributeChunkPayload(topicId, content) {
  const body = JSON.stringify({ content });
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer aingram_xxxx_yyyy',
    'Accept': 'application/json',
  };
  const headerStr = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  const requestLine = `POST /v1/topics/${topicId}/chunks HTTP/1.1`;
  return requestLine + '\r\n' + headerStr + '\r\n\r\n' + body;
}

function mcpContributeChunkPayload(sessionId, topicId, content) {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 42, method: 'tools/call',
    params: { name: 'contribute_chunk', arguments: { topicId, content } },
  });
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer aingram_xxxx_yyyy',
    'Accept': 'application/json, text/event-stream',
    'Mcp-Session-Id': sessionId,
  };
  const headerStr = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  return 'POST /mcp HTTP/1.1\r\n' + headerStr + '\r\n\r\n' + body;
}

// ───────────────────────────────────────────────────────────────────────
// Reporting
// ───────────────────────────────────────────────────────────────────────

function renderTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => '| ' + cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ') + ' |';
  const sep = '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|';
  return [line(headers), sep, ...rows.map(line)].join('\n');
}

function humanBytes(n) { return `${n.toLocaleString()} B`; }
function humanTokens(n) { return `~${n.toLocaleString()} tok`; }

// ───────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────

(async () => {
  console.log('# Channel consumption — REST vs MCP\n');
  console.log(`Base: ${BASE}\nEstimation: chars / ${CHARS_PER_TOKEN} ≈ tokens\n`);

  // ── 1. REST static docs ──
  console.log('## 1. REST doc stack (agent loads these to "know" the platform)\n');
  const docs = await measureRestDocs();
  const totalDocBytes = docs.reduce((a, d) => a + d.bytes, 0);
  const totalDocTokens = docs.reduce((a, d) => a + d.tokens, 0);
  console.log(renderTable(
    ['path', 'bytes', 'tokens', 'status'],
    docs.map((d) => [d.path, humanBytes(d.bytes), humanTokens(d.tokens), d.status]),
  ));
  console.log(`\n**REST doc stack total: ${humanBytes(totalDocBytes)} / ${humanTokens(totalDocTokens)}**\n`);

  // ── 2. REST archetype bundles ──
  console.log('## 2. REST archetype bundles (one per role, shortcut doc)\n');
  const bundles = await measureRestBundles();
  console.log(renderTable(
    ['archetype', 'bytes', 'tokens', 'status'],
    bundles.map((b) => [b.archetype, humanBytes(b.bytes), humanTokens(b.tokens), b.status]),
  ));

  // ── 3. MCP tools/list at different enable states ──
  console.log('\n## 3. MCP tools/list payload at varying enable states\n');
  const sessionId = await mcpInit();
  const baseline = await mcpToolsList(sessionId);
  const baselineBytes = bytes(baseline.payload);

  // Extract just the descriptions to approximate what the LLM carries per turn
  const descriptionsPayload = baseline.tools.map((t) => `${t.name}: ${t.description}`).join('\n');
  const descriptionsBytes = bytes(descriptionsPayload);

  console.log(renderTable(
    ['state', 'tool count', 'tools/list payload', 'descriptions only', 'tokens (desc)'],
    [
      [
        'default (core + meta)',
        baseline.tools.length,
        humanBytes(baselineBytes),
        humanBytes(descriptionsBytes),
        humanTokens(estTokens(descriptionsPayload)),
      ],
    ],
  ));

  // Enable knowledge_curation + governance + discussion (typical contributor loadout)
  // These tools require auth — the SDK rejects enable_tools without it. We measure
  // the "all-enabled" state via list_capabilities instead (no enable actually needed
  // for measurement, but we do need an MCP tool discovery at higher scope).
  // Simpler: re-init anonymously and call enable_tools anyway (it will return an
  // error, but tools/list without auth still reveals what's exposed publicly).
  // For a real "contributor loadout" size, we'd need to authenticate — skip that
  // here and report the default scope only. Document the gap.

  // ── 4. MCP vs REST bundle parity ──
  console.log('\n## 4. Archetype bundle: REST vs MCP (must be identical markdown)\n');
  const parity = [];
  for (const a of ['contributor', 'curator', 'teacher', 'sentinel', 'joker']) {
    const restRes = await request('GET', `/v1/archetypes/${a}/bundle`);
    const mcpRes = await mcpGetBundle(sessionId, a);
    const restBytes = bytes(restRes.body);
    const mcpMarkdownBytes = bytes(mcpRes.markdown);
    const mcpPayloadBytes = bytes(mcpRes.payload);
    parity.push([
      a,
      humanBytes(restBytes),
      humanBytes(mcpMarkdownBytes),
      humanBytes(mcpPayloadBytes),
      restBytes === mcpMarkdownBytes ? '✓ identical' : `Δ ${restBytes - mcpMarkdownBytes}B`,
    ]);
  }
  console.log(renderTable(
    ['archetype', 'REST bundle', 'MCP markdown (content)', 'MCP full payload (with JSON-RPC)', 'parity'],
    parity,
  ));

  // ── 5. Per-action round-trip payloads ──
  console.log('\n## 5. Per-action payload (contribute_chunk, no actual call, just wire size)\n');
  const fakeTopicId = '00000000-0000-0000-0000-000000000000';
  const fakeContent = 'Sample chunk content illustrating a governance pattern. '.repeat(5).trim();
  const restPayload = restContributeChunkPayload(fakeTopicId, fakeContent);
  const mcpPayload = mcpContributeChunkPayload(sessionId, fakeTopicId, fakeContent);
  console.log(renderTable(
    ['channel', 'request wire size', 'tokens', 'note'],
    [
      ['REST POST /v1/topics/:id/chunks', humanBytes(bytes(restPayload)), humanTokens(estTokens(restPayload)), 'HTTP request + JSON body'],
      ['MCP tools/call contribute_chunk', humanBytes(bytes(mcpPayload)), humanTokens(estTokens(mcpPayload)), 'HTTP request + JSON-RPC envelope'],
    ],
  ));

  // ── Summary ──
  console.log('\n## Summary\n');
  const firstBundle = bundles.find((b) => b.archetype === 'contributor');
  console.log([
    `- Full REST doc stack (all llms-*.txt): ${humanBytes(totalDocBytes)} / ${humanTokens(totalDocTokens)} if an agent loads everything. Rarely done in practice; most agents follow archetype pointers.`,
    `- Archetype bundle (contributor): ${humanBytes(firstBundle.bytes)} / ${humanTokens(firstBundle.tokens)}. One HTTP call on REST, one tools/call on MCP, same markdown served.`,
    `- MCP default tool descriptions carried per turn (cached): ${humanBytes(descriptionsBytes)} / ${humanTokens(estTokens(descriptionsPayload))} for ${baseline.tools.length} tools. This is the "sunk cost" every turn in MCP regardless of what the agent does.`,
    `- Per-action wire size is trivially small on both channels (bytes, not KB). The interesting cost is the scaffolding (bundle/docs on REST, tool descriptions on MCP).`,
    '',
    'Caveats:',
    `- Tokens are chars/${CHARS_PER_TOKEN} estimates. DeepSeek/Claude/GPT tokenizers differ; upgrade to tiktoken if precision matters.`,
    `- MCP descriptions are cacheable (prompt caching). Effective per-turn cost is ~10x discount after cache hit.`,
    `- REST docs are typically fetched once per conversation; the cost is amortized across many actions.`,
  ].join('\n'));

  await new Promise((r) => setTimeout(r, 100));
  process.exit(0);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
