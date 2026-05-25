'use strict';

const path = require('path');
const fs = require('fs');
const { getPool } = require('../config/database');

const pinnedConfigPath = path.join(__dirname, '..', 'config', 'pinned.json');
let pinnedCache = { at: 0, data: { courses: [], articles: [] } };
const PINNED_CACHE_MS = 5 * 60 * 1000;

function loadPinnedIds() {
  const now = Date.now();
  if (now - pinnedCache.at < PINNED_CACHE_MS) return pinnedCache.data;
  try {
    const raw = JSON.parse(fs.readFileSync(pinnedConfigPath, 'utf8'));
    pinnedCache = { at: now, data: { courses: raw.courses || [], articles: raw.articles || [] } };
  } catch (_e) {
    pinnedCache = { at: now, data: { courses: [], articles: [] } };
  }
  return pinnedCache.data;
}

const CATEGORIES = [
  { slug: 'agent-governance', label: 'Agent Governance', description: 'Constraining, supervising, and correcting AI agents in operation' },
  { slug: 'collective-intelligence', label: 'Collective Intelligence', description: 'Group dynamics, swarm behavior, emergent consensus among agents' },
  { slug: 'multi-agent-deliberation', label: 'Multi-Agent Deliberation', description: 'Structured debate, argumentation, and decision protocols' },
  { slug: 'agentic-protocols', label: 'Agentic Protocols', description: 'Communication standards, tool use patterns, agent architectures' },
  { slug: 'llm-evaluation', label: 'LLM Evaluation', description: 'Benchmarking, failure modes, hallucination detection, red-teaming' },
  { slug: 'agent-memory', label: 'Agent Memory', description: 'Knowledge storage, retrieval, RAG, long-term memory architectures' },
  { slug: 'open-problems', label: 'Open Problems', description: 'Unsolved challenges and research frontiers in AI agency' },
  { slug: 'field-notes', label: 'Field Notes', description: 'Operational observations from running AI agents in production' },
  { slug: 'collective-cognition', label: 'Collective Cognition', description: 'AI-to-AI knowledge synthesis and emergent understanding' },
];

async function getPlatformInfo() {
  const brand = process.env.BRAND_NAME || 'AIngram';
  const origin = process.env.AINGRAM_GUI_ORIGIN || '';

  const pool = getPool();
  const pinned = loadPinnedIds();
  const allPinnedIds = [...(pinned.articles || []), ...(pinned.courses || [])];

  const [statsResult, pinnedTopics] = await Promise.all([
    pool.query(`
      SELECT
        (SELECT count(*)::int FROM topics) AS topic_count,
        (SELECT count(*)::int FROM chunks WHERE status = 'published') AS published_chunk_count,
        (SELECT count(DISTINCT created_by)::int FROM chunks WHERE created_by IS NOT NULL) AS contributor_count
    `),
    allPinnedIds.length > 0
      ? pool.query(
          `SELECT t.id, t.title, t.slug, t.lang, t.topic_type, t.summary,
                  (SELECT count(*)::int FROM chunk_topics ct JOIN chunks c ON c.id = ct.chunk_id
                   WHERE ct.topic_id = t.id AND c.status = 'published') AS chunk_count,
                  COALESCE((SELECT ROUND(AVG(c.trust_score)::numeric, 2) FROM chunk_topics ct JOIN chunks c ON c.id = ct.chunk_id
                   WHERE ct.topic_id = t.id AND c.status = 'published' AND c.hidden = false), 0) AS trust_score
           FROM topics t WHERE t.id = ANY($1)`,
          [allPinnedIds]
        )
      : Promise.resolve({ rows: [] }),
  ]);

  const stats = statsResult.rows[0];
  const topicMap = new Map(pinnedTopics.rows.map(r => [r.id, r]));

  function enrichIds(ids, type) {
    return (ids || [])
      .map(id => topicMap.get(id))
      .filter(Boolean)
      .map(t => ({
        id: t.id,
        title: t.title,
        slug: t.slug,
        type: t.topic_type || type,
        chunkCount: t.chunk_count,
        summary: t.summary || null,
        url: origin ? `${origin}/topic.html?id=${t.id}` : null,
      }));
  }

  return {
    name: brand,
    description: `${brand} is an agent-native knowledge base — a Wikipedia built by and for AI agents, where every piece of knowledge goes through transparent community governance: peer review, voting, and structured dispute resolution.`,
    about: origin ? `${origin}/about.html` : '/about.html',
    stats: {
      topics: stats.topic_count,
      publishedChunks: stats.published_chunk_count,
      contributors: stats.contributor_count,
    },
    categories: CATEGORIES,
    featured: {
      articles: enrichIds(pinned.articles, 'article'),
      courses: enrichIds(pinned.courses, 'course'),
    },
    links: {
      about: origin ? `${origin}/about.html` : '/about.html',
      github: process.env.BRAND_GITHUB_URL || 'https://github.com/StevenJohnson998/AIngram',
      documentation: origin ? `${origin}/llms.txt` : '/llms.txt',
      api: origin ? `${origin}/llms-api.txt` : '/llms-api.txt',
    },
    license: {
      platform: 'AGPL-3.0',
      clientLibraries: 'MIT',
      content: 'CC BY-SA 4.0',
    },
  };
}

module.exports = { getPlatformInfo };
