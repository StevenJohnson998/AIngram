'use strict';

/**
 * Route suggester for 404 responses.
 * Loads the OpenAPI spec at startup and suggests similar routes when
 * an agent hits a non-existent endpoint. Zero cost on the happy path.
 */

const path = require('path');

let routeIndex = null;

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function loadIndex() {
  if (routeIndex) return routeIndex;
  try {
    const spec = require(path.join(__dirname, '..', 'gui', 'openapi.json'));
    routeIndex = [];
    for (const [pattern, methods] of Object.entries(spec.paths)) {
      const methodKeys = Object.keys(methods).filter(m => m !== 'parameters');
      const firstMethod = methods[methodKeys[0]] || {};
      routeIndex.push({
        pattern,
        methods: methodKeys.map(m => m.toUpperCase()),
        tag: firstMethod.tags?.[0] || '',
        summary: firstMethod.summary || '',
        segments: pattern.split('/').filter(Boolean).map(s => s.replace(/\{.*\}/, '*')),
      });
    }
  } catch {
    routeIndex = [];
  }
  return routeIndex;
}

/**
 * Score a candidate route against the attempted path.
 * Higher = better match.
 */
function score(attempted, candidate) {
  const aSegs = attempted.split('/').filter(Boolean);
  // Remove 'v1' prefix if present
  if (aSegs[0] === 'v1') aSegs.shift();

  const cSegs = candidate.segments;
  let points = 0;

  // Segment overlap with fuzzy matching
  for (const aSeg of aSegs) {
    // Skip UUID-like segments
    if (/^[0-9a-f]{8}-/.test(aSeg)) continue;
    for (const cSeg of cSegs) {
      if (cSeg === '*') continue;
      const dist = levenshtein(aSeg.toLowerCase(), cSeg.toLowerCase());
      if (dist === 0) points += 3;       // exact match
      else if (dist === 1) points += 2;  // off-by-one (pluralization)
      else if (dist === 2) points += 1;  // close (e.g., "topic" vs "topics")
    }
  }

  // Bonus for matching segment count
  const nonParamSegs = aSegs.filter(s => !/^[0-9a-f]{8}-/.test(s));
  if (nonParamSegs.length === cSegs.filter(s => s !== '*').length) points += 1;

  return points;
}

/**
 * Suggest up to `limit` routes for a missed path.
 * Returns [{ method, href, summary, tag }] sorted by relevance.
 */
function suggest(attemptedPath, limit = 3) {
  const index = loadIndex();
  if (index.length === 0) return [];

  const scored = index
    .map(r => ({ ...r, score: score(attemptedPath, r) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(r => ({
    method: r.methods[0],
    href: `/v1${r.pattern}`,
    summary: r.summary,
    tag: r.tag,
  }));
}

module.exports = { suggest };
