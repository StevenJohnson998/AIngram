#!/usr/bin/env node
/**
 * PASA Benchmark v2 — Policy Dimension Ablation + Curation Guarantee
 *
 * Extends the original PASA benchmark with two new measurements:
 *   Table 4: Policy dimension ablation (incremental filter activation)
 *   Table 5: Curation guarantee (PROPOSED vs CURRENT chunk filtering)
 *
 * Uses the same infrastructure: pgvector + HNSW, bge-m3 via Ollama,
 * 1000 chunks, ~93 subscriptions.
 *
 * Usage:
 *   docker exec aingram-api-test node benchmarks/pasa-v2.js
 *
 * Output: JSON to stdout, summary to stderr, file to pasa-v2-results.json.
 */

'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://172.18.0.1:11434';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'bge-m3';
const EMBEDDING_DIM = 1024;
const EMBEDDING_TIMEOUT_MS = 10000;

const NUM_CHUNKS = 1000;
const NUM_AGENTS = 50;
const DOMAINS = ['medical', 'financial', 'ai_safety', 'climate', 'cybersecurity'];
const SENSITIVITY_LEVELS = [1, 2, 3, 4, 5];
const SIMILARITY_THRESHOLD = 0.7;

const BENCH_PREFIX = 'pasa_v2_';

// ---------------------------------------------------------------------------
// Domain-specific content templates (same as v1)
// ---------------------------------------------------------------------------

const DOMAIN_TEMPLATES = {
  medical: {
    topics: [
      'drug interaction adverse effects in elderly patients',
      'clinical trial results for immunotherapy treatments',
      'pharmacological contraindications with cardiovascular medications',
      'genetic markers for hereditary disease susceptibility',
      'antibiotic resistance mechanisms in hospital infections',
      'neurological side effects of chemotherapy protocols',
      'pediatric dosage adjustments for rare conditions',
      'surgical complications from minimally invasive procedures',
      'vaccine efficacy against emerging viral variants',
      'diagnostic biomarkers for early cancer detection',
    ],
    keywords: ['drug', 'clinical', 'patient', 'treatment', 'medical', 'therapy', 'disease', 'diagnosis'],
  },
  financial: {
    topics: [
      'algorithmic trading risk assessment frameworks',
      'regulatory compliance for cross-border transactions',
      'credit scoring model bias detection methods',
      'cryptocurrency exchange vulnerability analysis',
      'anti-money laundering pattern recognition systems',
      'insurance fraud detection using behavioral analytics',
      'portfolio risk optimization under volatile markets',
      'central bank digital currency implementation challenges',
      'sustainable finance ESG scoring methodologies',
      'high-frequency trading latency optimization techniques',
    ],
    keywords: ['trading', 'risk', 'financial', 'compliance', 'banking', 'fraud', 'market', 'regulation'],
  },
  ai_safety: {
    topics: [
      'alignment techniques for large language models',
      'adversarial attack detection in neural networks',
      'fairness metrics for automated decision systems',
      'interpretability methods for deep learning classifiers',
      'robustness testing for autonomous vehicle perception',
      'bias mitigation in training data curation',
      'safety evaluation frameworks for agentic AI systems',
      'red teaming methodologies for foundation models',
      'constitutional AI and value alignment approaches',
      'emergent capabilities and capability control mechanisms',
    ],
    keywords: ['alignment', 'safety', 'bias', 'robustness', 'fairness', 'adversarial', 'model', 'AI'],
  },
  climate: {
    topics: [
      'carbon capture technology efficiency measurements',
      'ocean acidification impact on marine ecosystems',
      'renewable energy grid integration challenges',
      'permafrost thawing methane release projections',
      'urban heat island mitigation strategies',
      'deforestation monitoring using satellite imagery',
      'climate model uncertainty quantification methods',
      'agricultural adaptation to changing precipitation patterns',
      'sea level rise coastal infrastructure vulnerability',
      'atmospheric aerosol radiative forcing estimates',
    ],
    keywords: ['climate', 'carbon', 'emissions', 'renewable', 'ocean', 'temperature', 'energy', 'environmental'],
  },
  cybersecurity: {
    topics: [
      'zero-day vulnerability discovery in IoT firmware',
      'ransomware propagation patterns in enterprise networks',
      'supply chain attack vectors in software dependencies',
      'post-quantum cryptography migration strategies',
      'insider threat detection using behavioral analytics',
      'cloud infrastructure misconfiguration exploitation',
      'DNS exfiltration techniques and countermeasures',
      'advanced persistent threat attribution methodologies',
      'container escape vulnerabilities in orchestration platforms',
      'social engineering attack simulation frameworks',
    ],
    keywords: ['vulnerability', 'attack', 'security', 'threat', 'encryption', 'malware', 'exploit', 'cyber'],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function generateEmbedding(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
  try {
    const response = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.embeddings || !Array.isArray(data.embeddings[0])) {
      throw new Error('Unexpected response shape');
    }
    return data.embeddings[0];
  } finally {
    clearTimeout(timer);
  }
}

async function generateEmbeddings(texts, label) {
  const embeddings = [];
  const batchSize = 10;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const results = [];
    for (const text of batch) {
      results.push(await generateEmbedding(text));
    }
    embeddings.push(...results);
    if ((i + batchSize) % 100 === 0 || i + batchSize >= texts.length) {
      process.stderr.write(`\r  ${label}: ${Math.min(i + batchSize, texts.length)}/${texts.length}`);
    }
  }
  process.stderr.write('\n');
  return embeddings;
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ---------------------------------------------------------------------------
// Generate synthetic content
// ---------------------------------------------------------------------------

function generateVariation(domain, index) {
  const adjectives = ['novel', 'critical', 'emerging', 'significant', 'preliminary', 'definitive', 'unexpected', 'validated'];
  const verbs = ['demonstrates', 'reveals', 'confirms', 'challenges', 'extends', 'quantifies', 'identifies', 'establishes'];
  const adj = adjectives[index % adjectives.length];
  const verb = verbs[(index * 3) % verbs.length];
  return `This ${adj} research ${verb} important implications for the ${domain.replace('_', ' ')} domain.`;
}

function assignSensitivity(domain, index, total) {
  const weights = {
    medical:        [0.05, 0.10, 0.25, 0.35, 0.25],
    financial:      [0.10, 0.15, 0.30, 0.25, 0.20],
    ai_safety:      [0.15, 0.25, 0.30, 0.20, 0.10],
    climate:        [0.30, 0.30, 0.20, 0.15, 0.05],
    cybersecurity:  [0.05, 0.15, 0.25, 0.30, 0.25],
  };
  const w = weights[domain];
  const r = (index / total);
  let cumulative = 0;
  for (let lvl = 0; lvl < 5; lvl++) {
    cumulative += w[lvl];
    if (r < cumulative) return lvl + 1;
  }
  return 5;
}

function generateChunkTexts(count) {
  const texts = [];
  const meta = [];
  const chunksPerDomain = Math.floor(count / DOMAINS.length);

  for (const domain of DOMAINS) {
    const templates = DOMAIN_TEMPLATES[domain].topics;
    for (let i = 0; i < chunksPerDomain; i++) {
      const base = templates[i % templates.length];
      const variation = `${base}. Finding ${i + 1}: ${generateVariation(domain, i)}`;
      const sensitivity = assignSensitivity(domain, i, chunksPerDomain);

      // --- v2 additions: policy flags ---
      // commercial_opt_out: ~30% overall, biased toward medical/financial
      const commercialBias = { medical: 0.50, financial: 0.45, ai_safety: 0.20, climate: 0.15, cybersecurity: 0.25 };
      const commercial_opt_out = Math.random() < commercialBias[domain];

      // training_opt_out: ~20% overall
      const trainingBias = { medical: 0.30, financial: 0.25, ai_safety: 0.20, climate: 0.10, cybersecurity: 0.15 };
      const training_opt_out = Math.random() < trainingBias[domain];

      // scientific_only: ~15% overall, biased toward medical
      const scientificBias = { medical: 0.35, financial: 0.05, ai_safety: 0.15, climate: 0.10, cybersecurity: 0.10 };
      const scientific_only = Math.random() < scientificBias[domain];

      // jurisdiction: EU/US/global
      const jRand = Math.random();
      const jurisdiction = jRand < 0.35 ? 'EU' : (jRand < 0.65 ? 'US' : 'global');

      // status: ~25% PROPOSED, rest CURRENT
      const status = Math.random() < 0.25 ? 'proposed' : 'current';

      texts.push(variation);
      meta.push({ domain, sensitivity, commercial_opt_out, training_opt_out, scientific_only, jurisdiction, status });
    }
  }

  return { texts, meta };
}

function generateAgents(count) {
  const agents = [];
  const agentsPerLevel = Math.floor(count / 5);
  const purposes = ['scientific', 'commercial', 'mixed'];
  const jurisdictions = ['EU', 'US'];

  for (let i = 0; i < count; i++) {
    const level = Math.min(5, Math.floor(i / agentsPerLevel) + 1);
    const domain = DOMAINS[i % DOMAINS.length];
    const numSubs = randInt(1, 3);

    // v2: agent properties for ablation
    const purpose = purposes[i % purposes.length]; // ~equal split
    const training_use = Math.random() < 0.40;     // ~40%
    const jurisdiction = jurisdictions[i % jurisdictions.length]; // ~equal split

    agents.push({ index: i, level, domain, numSubs, purpose, training_use, jurisdiction });
  }
  return agents;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

async function setupBenchmarkData(pool, chunkTexts, chunkMeta, chunkEmbeddings, agents) {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${BENCH_PREFIX}chunks (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        domain VARCHAR(50) NOT NULL,
        sensitivity INT NOT NULL,
        commercial_opt_out BOOLEAN NOT NULL DEFAULT false,
        training_opt_out BOOLEAN NOT NULL DEFAULT false,
        scientific_only BOOLEAN NOT NULL DEFAULT false,
        jurisdiction VARCHAR(10) NOT NULL DEFAULT 'global',
        status VARCHAR(20) NOT NULL DEFAULT 'current',
        embedding vector(${EMBEDDING_DIM})
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${BENCH_PREFIX}agents (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        data_handling_level INT NOT NULL,
        domain VARCHAR(50) NOT NULL,
        purpose VARCHAR(20) NOT NULL DEFAULT 'mixed',
        training_use BOOLEAN NOT NULL DEFAULT false,
        jurisdiction VARCHAR(10) NOT NULL DEFAULT 'US'
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${BENCH_PREFIX}subscriptions (
        id SERIAL PRIMARY KEY,
        agent_id INT REFERENCES ${BENCH_PREFIX}agents(id),
        embedding vector(${EMBEDDING_DIM}),
        similarity_threshold FLOAT NOT NULL DEFAULT ${SIMILARITY_THRESHOLD},
        max_sensitivity INT NOT NULL,
        domain VARCHAR(50) NOT NULL,
        active BOOLEAN DEFAULT true
      )
    `);

    // Insert chunks
    process.stderr.write('  Inserting chunks...\n');
    for (let i = 0; i < chunkTexts.length; i++) {
      const m = chunkMeta[i];
      const vecStr = `[${chunkEmbeddings[i].join(',')}]`;
      await client.query(
        `INSERT INTO ${BENCH_PREFIX}chunks (content, domain, sensitivity, commercial_opt_out, training_opt_out, scientific_only, jurisdiction, status, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)`,
        [chunkTexts[i], m.domain, m.sensitivity, m.commercial_opt_out, m.training_opt_out, m.scientific_only, m.jurisdiction, m.status, vecStr]
      );
    }

    // Insert agents
    process.stderr.write('  Inserting agents...\n');
    for (const agent of agents) {
      await client.query(
        `INSERT INTO ${BENCH_PREFIX}agents (name, data_handling_level, domain, purpose, training_use, jurisdiction)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [`agent_${agent.index}`, agent.level, agent.domain, agent.purpose, agent.training_use, agent.jurisdiction]
      );
    }

    // HNSW indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${BENCH_PREFIX}chunks_emb_idx
      ON ${BENCH_PREFIX}chunks USING hnsw (embedding vector_cosine_ops)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS ${BENCH_PREFIX}subs_emb_idx
      ON ${BENCH_PREFIX}subscriptions USING hnsw (embedding vector_cosine_ops)
      WHERE active = true
    `);

    return client;
  } catch (err) {
    client.release();
    throw err;
  }
}

async function insertSubscriptions(pool, subscriptions) {
  for (const sub of subscriptions) {
    const vecStr = `[${sub.embedding.join(',')}]`;
    await pool.query(
      `INSERT INTO ${BENCH_PREFIX}subscriptions (agent_id, embedding, similarity_threshold, max_sensitivity, domain, active)
       VALUES ($1, $2::vector, $3, $4, $5, true)`,
      [sub.agentId, vecStr, sub.threshold, sub.maxSensitivity, sub.domain]
    );
  }
}

async function cleanupBenchmarkData(pool) {
  await pool.query(`DROP TABLE IF EXISTS ${BENCH_PREFIX}subscriptions CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS ${BENCH_PREFIX}chunks CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS ${BENCH_PREFIX}agents CASCADE`);
}

// ---------------------------------------------------------------------------
// Matching functions for ablation study
// ---------------------------------------------------------------------------

/**
 * Level-only filtering: chunk.sensitivity <= agent.level
 */
async function matchLevelOnly(pool, chunkId) {
  const { rows } = await pool.query(
    `SELECT s.id as subscription_id, s.agent_id,
            1 - (s.embedding <=> c.embedding) as similarity,
            c.sensitivity as chunk_sensitivity, s.max_sensitivity,
            c.commercial_opt_out, c.training_opt_out, c.scientific_only,
            c.jurisdiction as chunk_jurisdiction,
            a.purpose, a.training_use, a.jurisdiction as agent_jurisdiction
     FROM ${BENCH_PREFIX}subscriptions s
     JOIN ${BENCH_PREFIX}chunks c ON c.id = $1
     JOIN ${BENCH_PREFIX}agents a ON a.id = s.agent_id
     WHERE s.active = true
       AND s.embedding IS NOT NULL
       AND 1 - (s.embedding <=> c.embedding) >= s.similarity_threshold
       AND c.sensitivity <= s.max_sensitivity`,
    [chunkId]
  );
  return rows;
}

/**
 * Level + commercial_opt_out filtering
 */
async function matchLevelCommercial(pool, chunkId) {
  const { rows } = await pool.query(
    `SELECT s.id as subscription_id, s.agent_id,
            1 - (s.embedding <=> c.embedding) as similarity,
            c.sensitivity as chunk_sensitivity, s.max_sensitivity,
            c.commercial_opt_out, c.training_opt_out, c.scientific_only,
            c.jurisdiction as chunk_jurisdiction,
            a.purpose, a.training_use, a.jurisdiction as agent_jurisdiction
     FROM ${BENCH_PREFIX}subscriptions s
     JOIN ${BENCH_PREFIX}chunks c ON c.id = $1
     JOIN ${BENCH_PREFIX}agents a ON a.id = s.agent_id
     WHERE s.active = true
       AND s.embedding IS NOT NULL
       AND 1 - (s.embedding <=> c.embedding) >= s.similarity_threshold
       AND c.sensitivity <= s.max_sensitivity
       AND (c.commercial_opt_out = false OR a.purpose = 'scientific')`,
    [chunkId]
  );
  return rows;
}

/**
 * Level + commercial + training_opt_out filtering
 */
async function matchLevelCommercialTraining(pool, chunkId) {
  const { rows } = await pool.query(
    `SELECT s.id as subscription_id, s.agent_id,
            1 - (s.embedding <=> c.embedding) as similarity,
            c.sensitivity as chunk_sensitivity, s.max_sensitivity,
            c.commercial_opt_out, c.training_opt_out, c.scientific_only,
            c.jurisdiction as chunk_jurisdiction,
            a.purpose, a.training_use, a.jurisdiction as agent_jurisdiction
     FROM ${BENCH_PREFIX}subscriptions s
     JOIN ${BENCH_PREFIX}chunks c ON c.id = $1
     JOIN ${BENCH_PREFIX}agents a ON a.id = s.agent_id
     WHERE s.active = true
       AND s.embedding IS NOT NULL
       AND 1 - (s.embedding <=> c.embedding) >= s.similarity_threshold
       AND c.sensitivity <= s.max_sensitivity
       AND (c.commercial_opt_out = false OR a.purpose = 'scientific')
       AND (c.training_opt_out = false OR a.training_use = false)`,
    [chunkId]
  );
  return rows;
}

/**
 * All dimensions: level + commercial + training + scientific_only + jurisdiction
 */
async function matchAllDimensions(pool, chunkId) {
  const { rows } = await pool.query(
    `SELECT s.id as subscription_id, s.agent_id,
            1 - (s.embedding <=> c.embedding) as similarity,
            c.sensitivity as chunk_sensitivity, s.max_sensitivity,
            c.commercial_opt_out, c.training_opt_out, c.scientific_only,
            c.jurisdiction as chunk_jurisdiction,
            a.purpose, a.training_use, a.jurisdiction as agent_jurisdiction
     FROM ${BENCH_PREFIX}subscriptions s
     JOIN ${BENCH_PREFIX}chunks c ON c.id = $1
     JOIN ${BENCH_PREFIX}agents a ON a.id = s.agent_id
     WHERE s.active = true
       AND s.embedding IS NOT NULL
       AND 1 - (s.embedding <=> c.embedding) >= s.similarity_threshold
       AND c.sensitivity <= s.max_sensitivity
       AND (c.commercial_opt_out = false OR a.purpose = 'scientific')
       AND (c.training_opt_out = false OR a.training_use = false)
       AND (c.scientific_only = false OR a.purpose = 'scientific')
       AND (c.jurisdiction = 'global' OR c.jurisdiction = a.jurisdiction)`,
    [chunkId]
  );
  return rows;
}

/**
 * Ungoverned (similarity only) — baseline for violation counting
 */
async function matchUngoverned(pool, chunkId) {
  const { rows } = await pool.query(
    `SELECT s.id as subscription_id, s.agent_id,
            1 - (s.embedding <=> c.embedding) as similarity,
            c.sensitivity as chunk_sensitivity, s.max_sensitivity,
            c.commercial_opt_out, c.training_opt_out, c.scientific_only,
            c.jurisdiction as chunk_jurisdiction,
            a.purpose, a.training_use, a.jurisdiction as agent_jurisdiction
     FROM ${BENCH_PREFIX}subscriptions s
     JOIN ${BENCH_PREFIX}chunks c ON c.id = $1
     JOIN ${BENCH_PREFIX}agents a ON a.id = s.agent_id
     WHERE s.active = true
       AND s.embedding IS NOT NULL
       AND 1 - (s.embedding <=> c.embedding) >= s.similarity_threshold`,
    [chunkId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Curation matching functions
// ---------------------------------------------------------------------------

/**
 * With curation guarantee: only CURRENT chunks trigger subscriptions.
 */
async function matchWithCuration(pool, chunkId) {
  const { rows } = await pool.query(
    `SELECT s.id as subscription_id, s.agent_id,
            1 - (s.embedding <=> c.embedding) as similarity,
            c.sensitivity as chunk_sensitivity, s.max_sensitivity,
            c.status
     FROM ${BENCH_PREFIX}subscriptions s
     JOIN ${BENCH_PREFIX}chunks c ON c.id = $1
     JOIN ${BENCH_PREFIX}agents a ON a.id = s.agent_id
     WHERE s.active = true
       AND s.embedding IS NOT NULL
       AND 1 - (s.embedding <=> c.embedding) >= s.similarity_threshold
       AND c.sensitivity <= s.max_sensitivity
       AND c.status = 'current'`,
    [chunkId]
  );
  return rows;
}

/**
 * Without curation: all chunks (CURRENT + PROPOSED) trigger subscriptions.
 */
async function matchWithoutCuration(pool, chunkId) {
  const { rows } = await pool.query(
    `SELECT s.id as subscription_id, s.agent_id,
            1 - (s.embedding <=> c.embedding) as similarity,
            c.sensitivity as chunk_sensitivity, s.max_sensitivity,
            c.status
     FROM ${BENCH_PREFIX}subscriptions s
     JOIN ${BENCH_PREFIX}chunks c ON c.id = $1
     JOIN ${BENCH_PREFIX}agents a ON a.id = s.agent_id
     WHERE s.active = true
       AND s.embedding IS NOT NULL
       AND 1 - (s.embedding <=> c.embedding) >= s.similarity_threshold
       AND c.sensitivity <= s.max_sensitivity`,
    [chunkId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Violation detection helpers
// ---------------------------------------------------------------------------

function isLevelViolation(match) {
  return parseInt(match.chunk_sensitivity) > parseInt(match.max_sensitivity);
}

function isCommercialViolation(match) {
  return match.commercial_opt_out === true && match.purpose !== 'scientific';
}

function isTrainingViolation(match) {
  return match.training_opt_out === true && match.training_use === true;
}

function isScientificOnlyViolation(match) {
  return match.scientific_only === true && match.purpose !== 'scientific';
}

function isJurisdictionViolation(match) {
  return match.chunk_jurisdiction !== 'global' && match.chunk_jurisdiction !== match.agent_jurisdiction;
}

function countAnyViolation(match) {
  return isLevelViolation(match)
    || isCommercialViolation(match)
    || isTrainingViolation(match)
    || isScientificOnlyViolation(match)
    || isJurisdictionViolation(match);
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

async function runBenchmark() {
  process.stderr.write('=== PASA Benchmark v2 ===\n\n');

  const pool = new Pool({
    host: process.env.DB_HOST || 'postgres',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'aingram_test',
    user: process.env.DB_USER || 'admin',
    password: process.env.DB_PASSWORD || '',
    max: 5,
  });

  // Verify connectivity
  try {
    await pool.query('SELECT 1');
    process.stderr.write('[OK] Database connected\n');
  } catch (err) {
    process.stderr.write(`[FAIL] Database connection: ${err.message}\n`);
    process.exit(1);
  }

  try {
    const testEmb = await generateEmbedding('test');
    if (!testEmb || testEmb.length !== EMBEDDING_DIM) {
      throw new Error(`Expected ${EMBEDDING_DIM} dims, got ${testEmb?.length}`);
    }
    process.stderr.write(`[OK] Ollama ${EMBEDDING_MODEL} (${EMBEDDING_DIM}d)\n`);
  } catch (err) {
    process.stderr.write(`[FAIL] Ollama: ${err.message}\n`);
    process.exit(1);
  }

  // Cleanup previous run
  await cleanupBenchmarkData(pool);

  const results = {};

  try {
    // -----------------------------------------------------------------------
    // Phase 1: Generate synthetic data
    // -----------------------------------------------------------------------
    process.stderr.write('\n--- Phase 1: Generating synthetic data ---\n');

    const { texts: chunkTexts, meta: chunkMeta } = generateChunkTexts(NUM_CHUNKS);
    process.stderr.write(`  ${chunkTexts.length} chunks generated across ${DOMAINS.length} domains\n`);

    // Log distribution of new flags
    const flagStats = {
      commercial_opt_out: chunkMeta.filter(m => m.commercial_opt_out).length,
      training_opt_out: chunkMeta.filter(m => m.training_opt_out).length,
      scientific_only: chunkMeta.filter(m => m.scientific_only).length,
      jurisdiction_EU: chunkMeta.filter(m => m.jurisdiction === 'EU').length,
      jurisdiction_US: chunkMeta.filter(m => m.jurisdiction === 'US').length,
      jurisdiction_global: chunkMeta.filter(m => m.jurisdiction === 'global').length,
      status_proposed: chunkMeta.filter(m => m.status === 'proposed').length,
      status_current: chunkMeta.filter(m => m.status === 'current').length,
    };
    process.stderr.write(`  Flag distribution: ${JSON.stringify(flagStats)}\n`);

    const agents = generateAgents(NUM_AGENTS);
    const agentStats = {
      purpose_scientific: agents.filter(a => a.purpose === 'scientific').length,
      purpose_commercial: agents.filter(a => a.purpose === 'commercial').length,
      purpose_mixed: agents.filter(a => a.purpose === 'mixed').length,
      training_use: agents.filter(a => a.training_use).length,
      jurisdiction_EU: agents.filter(a => a.jurisdiction === 'EU').length,
      jurisdiction_US: agents.filter(a => a.jurisdiction === 'US').length,
    };
    process.stderr.write(`  Agent distribution: ${JSON.stringify(agentStats)}\n`);

    // Generate embeddings
    process.stderr.write('  Generating chunk embeddings...\n');
    const chunkEmbeddings = await generateEmbeddings(chunkTexts, 'Chunks');

    process.stderr.write('  Setting up database tables...\n');
    const setupClient = await setupBenchmarkData(pool, chunkTexts, chunkMeta, chunkEmbeddings, agents);
    setupClient.release();

    // Generate subscription embeddings
    process.stderr.write('  Generating subscription embeddings...\n');
    const subscriptionData = [];
    const subscriptionTexts = [];
    for (const agent of agents) {
      const templates = DOMAIN_TEMPLATES[agent.domain].topics;
      for (let s = 0; s < agent.numSubs; s++) {
        const subTopic = templates[randInt(0, templates.length - 1)];
        subscriptionTexts.push(subTopic);
        subscriptionData.push({
          agentIndex: agent.index,
          domain: agent.domain,
          maxSensitivity: agent.level,
          threshold: SIMILARITY_THRESHOLD,
        });
      }
    }

    const subEmbeddings = await generateEmbeddings(subscriptionTexts, 'Subscriptions');

    const allSubs = subscriptionData.map((sd, i) => ({
      agentId: sd.agentIndex + 1,
      embedding: subEmbeddings[i],
      threshold: sd.threshold,
      maxSensitivity: sd.maxSensitivity,
      domain: sd.domain,
    }));
    await insertSubscriptions(pool, allSubs);
    process.stderr.write(`  ${allSubs.length} subscriptions inserted\n`);

    await pool.query(`ANALYZE ${BENCH_PREFIX}chunks`);
    await pool.query(`ANALYZE ${BENCH_PREFIX}subscriptions`);

    // -----------------------------------------------------------------------
    // Phase 2: Policy Dimension Ablation (Table 4)
    // -----------------------------------------------------------------------
    process.stderr.write('\n--- Phase 2: Policy Dimension Ablation (Table 4) ---\n');

    // Use all chunks for comprehensive measurement
    const { rows: allChunks } = await pool.query(
      `SELECT id, sensitivity, domain, commercial_opt_out, training_opt_out, scientific_only, jurisdiction, status
       FROM ${BENCH_PREFIX}chunks`
    );

    const ablation = {
      ungoverned: { total_notifications: 0, violations: { level: 0, commercial: 0, training: 0, scientific_only: 0, jurisdiction: 0, any: 0 } },
      level_only: { total_notifications: 0, violations: { level: 0, commercial: 0, training: 0, scientific_only: 0, jurisdiction: 0, any: 0 } },
      level_commercial: { total_notifications: 0, violations: { level: 0, commercial: 0, training: 0, scientific_only: 0, jurisdiction: 0, any: 0 } },
      level_commercial_training: { total_notifications: 0, violations: { level: 0, commercial: 0, training: 0, scientific_only: 0, jurisdiction: 0, any: 0 } },
      all_dimensions: { total_notifications: 0, violations: { level: 0, commercial: 0, training: 0, scientific_only: 0, jurisdiction: 0, any: 0 } },
    };

    // Sample 200 chunks for ablation (balance between speed and coverage)
    const ablationSampleSize = 200;
    const { rows: ablationChunks } = await pool.query(
      `SELECT id FROM ${BENCH_PREFIX}chunks ORDER BY RANDOM() LIMIT $1`,
      [ablationSampleSize]
    );

    for (let i = 0; i < ablationChunks.length; i++) {
      const chunkId = ablationChunks[i].id;
      if (i % 50 === 0) process.stderr.write(`\r  Ablation: chunk ${i + 1}/${ablationChunks.length}`);

      // Ungoverned (similarity only)
      const ungov = await matchUngoverned(pool, chunkId);
      ablation.ungoverned.total_notifications += ungov.length;
      for (const m of ungov) {
        if (isLevelViolation(m)) ablation.ungoverned.violations.level++;
        if (isCommercialViolation(m)) ablation.ungoverned.violations.commercial++;
        if (isTrainingViolation(m)) ablation.ungoverned.violations.training++;
        if (isScientificOnlyViolation(m)) ablation.ungoverned.violations.scientific_only++;
        if (isJurisdictionViolation(m)) ablation.ungoverned.violations.jurisdiction++;
        if (countAnyViolation(m)) ablation.ungoverned.violations.any++;
      }

      // Level only
      const lvl = await matchLevelOnly(pool, chunkId);
      ablation.level_only.total_notifications += lvl.length;
      for (const m of lvl) {
        if (isLevelViolation(m)) ablation.level_only.violations.level++;
        if (isCommercialViolation(m)) ablation.level_only.violations.commercial++;
        if (isTrainingViolation(m)) ablation.level_only.violations.training++;
        if (isScientificOnlyViolation(m)) ablation.level_only.violations.scientific_only++;
        if (isJurisdictionViolation(m)) ablation.level_only.violations.jurisdiction++;
        if (countAnyViolation(m)) ablation.level_only.violations.any++;
      }

      // Level + commercial
      const lvlCom = await matchLevelCommercial(pool, chunkId);
      ablation.level_commercial.total_notifications += lvlCom.length;
      for (const m of lvlCom) {
        if (isLevelViolation(m)) ablation.level_commercial.violations.level++;
        if (isCommercialViolation(m)) ablation.level_commercial.violations.commercial++;
        if (isTrainingViolation(m)) ablation.level_commercial.violations.training++;
        if (isScientificOnlyViolation(m)) ablation.level_commercial.violations.scientific_only++;
        if (isJurisdictionViolation(m)) ablation.level_commercial.violations.jurisdiction++;
        if (countAnyViolation(m)) ablation.level_commercial.violations.any++;
      }

      // Level + commercial + training
      const lvlComTrn = await matchLevelCommercialTraining(pool, chunkId);
      ablation.level_commercial_training.total_notifications += lvlComTrn.length;
      for (const m of lvlComTrn) {
        if (isLevelViolation(m)) ablation.level_commercial_training.violations.level++;
        if (isCommercialViolation(m)) ablation.level_commercial_training.violations.commercial++;
        if (isTrainingViolation(m)) ablation.level_commercial_training.violations.training++;
        if (isScientificOnlyViolation(m)) ablation.level_commercial_training.violations.scientific_only++;
        if (isJurisdictionViolation(m)) ablation.level_commercial_training.violations.jurisdiction++;
        if (countAnyViolation(m)) ablation.level_commercial_training.violations.any++;
      }

      // All dimensions
      const allDim = await matchAllDimensions(pool, chunkId);
      ablation.all_dimensions.total_notifications += allDim.length;
      for (const m of allDim) {
        if (isLevelViolation(m)) ablation.all_dimensions.violations.level++;
        if (isCommercialViolation(m)) ablation.all_dimensions.violations.commercial++;
        if (isTrainingViolation(m)) ablation.all_dimensions.violations.training++;
        if (isScientificOnlyViolation(m)) ablation.all_dimensions.violations.scientific_only++;
        if (isJurisdictionViolation(m)) ablation.all_dimensions.violations.jurisdiction++;
        if (countAnyViolation(m)) ablation.all_dimensions.violations.any++;
      }
    }
    process.stderr.write('\n');

    // Compute blocked counts relative to ungoverned baseline
    const ungovAny = ablation.ungoverned.violations.any;
    for (const key of ['level_only', 'level_commercial', 'level_commercial_training', 'all_dimensions']) {
      ablation[key].violations_blocked = ungovAny - ablation[key].violations.any;
      ablation[key].block_rate = ungovAny > 0 ? (ungovAny - ablation[key].violations.any) / ungovAny : 1;
    }

    results.policy_dimension_ablation = {
      sample_size: ablationSampleSize,
      ...ablation,
    };

    // -----------------------------------------------------------------------
    // Phase 3: Curation Guarantee (Table 5)
    // -----------------------------------------------------------------------
    process.stderr.write('\n--- Phase 3: Curation Guarantee (Table 5) ---\n');

    // Count actual status distribution in DB
    const { rows: statusDist } = await pool.query(
      `SELECT status, COUNT(*) as cnt FROM ${BENCH_PREFIX}chunks GROUP BY status`
    );
    const statusMap = {};
    for (const r of statusDist) statusMap[r.status] = parseInt(r.cnt);
    process.stderr.write(`  Chunk status distribution: ${JSON.stringify(statusMap)}\n`);

    const curation = {
      with_curation: { total_notifications: 0, from_current: 0, from_proposed: 0 },
      without_curation: { total_notifications: 0, from_current: 0, from_proposed: 0 },
    };

    // Test all chunks for curation measurement
    const curationSampleSize = 200;
    const { rows: curationChunks } = await pool.query(
      `SELECT id, status FROM ${BENCH_PREFIX}chunks ORDER BY RANDOM() LIMIT $1`,
      [curationSampleSize]
    );

    for (let i = 0; i < curationChunks.length; i++) {
      const chunk = curationChunks[i];
      if (i % 50 === 0) process.stderr.write(`\r  Curation: chunk ${i + 1}/${curationChunks.length}`);

      // With curation (only CURRENT triggers)
      const withCur = await matchWithCuration(pool, chunk.id);
      curation.with_curation.total_notifications += withCur.length;
      for (const m of withCur) {
        if (m.status === 'current') curation.with_curation.from_current++;
        else curation.with_curation.from_proposed++;
      }

      // Without curation (all trigger)
      const withoutCur = await matchWithoutCuration(pool, chunk.id);
      curation.without_curation.total_notifications += withoutCur.length;
      for (const m of withoutCur) {
        if (chunk.status === 'current') curation.without_curation.from_current++;
        else curation.without_curation.from_proposed++;
      }
    }
    process.stderr.write('\n');

    // Compute unvalidated notification stats
    const proposedInSample = curationChunks.filter(c => c.status === 'proposed').length;
    const currentInSample = curationChunks.filter(c => c.status === 'current').length;

    curation.chunk_counts = {
      total: statusMap.current + (statusMap.proposed || 0),
      current: statusMap.current || 0,
      proposed: statusMap.proposed || 0,
      sample_size: curationSampleSize,
      sample_current: currentInSample,
      sample_proposed: proposedInSample,
    };

    // The key metric: how many unvalidated notifications leak without curation
    curation.unvalidated_leak = {
      notifications_from_proposed: curation.without_curation.from_proposed,
      total_without_curation: curation.without_curation.total_notifications,
      leak_rate: curation.without_curation.total_notifications > 0
        ? curation.without_curation.from_proposed / curation.without_curation.total_notifications
        : 0,
      prevented_by_curation: curation.without_curation.from_proposed - curation.with_curation.from_proposed,
    };

    results.curation_guarantee = curation;

    // -----------------------------------------------------------------------
    // Config
    // -----------------------------------------------------------------------
    results.config = {
      num_chunks: NUM_CHUNKS,
      num_agents: NUM_AGENTS,
      domains: DOMAINS,
      similarity_threshold: SIMILARITY_THRESHOLD,
      embedding_model: EMBEDDING_MODEL,
      embedding_dim: EMBEDDING_DIM,
      total_subscriptions: allSubs.length,
      ablation_sample_size: ablationSampleSize,
      curation_sample_size: curationSampleSize,
      chunk_flags: flagStats,
      agent_flags: agentStats,
      timestamp: new Date().toISOString(),
    };

  } finally {
    process.stderr.write('\n--- Cleanup ---\n');
    await cleanupBenchmarkData(pool);
    process.stderr.write('  Benchmark tables dropped\n');
    await pool.end();
  }

  return results;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printSummary(results) {
  const w = (s) => process.stderr.write(s + '\n');

  w('\n========================================');
  w('  PASA Benchmark v2 Results');
  w('========================================\n');

  const cfg = results.config;
  w(`Config: ${cfg.num_chunks} chunks, ${cfg.num_agents} agents, ${cfg.total_subscriptions} subscriptions`);
  w(`Model: ${cfg.embedding_model} (${cfg.embedding_dim}d), threshold: ${cfg.similarity_threshold}\n`);

  // Table 4: Policy Dimension Ablation
  w('--- Table 4: Policy Dimension Ablation ---');
  w(`  Sample: ${results.policy_dimension_ablation.sample_size} chunks\n`);
  w('  Filter Config          | Notifs | Violations | Blocked | Block Rate');
  w('  -----------------------+--------+------------+---------+-----------');
  const abl = results.policy_dimension_ablation;
  const rows = [
    ['Ungoverned (none)', abl.ungoverned.total_notifications, abl.ungoverned.violations.any, '-', '-'],
    ['Level only', abl.level_only.total_notifications, abl.level_only.violations.any, abl.level_only.violations_blocked, (abl.level_only.block_rate * 100).toFixed(1) + '%'],
    ['+ commercial_opt_out', abl.level_commercial.total_notifications, abl.level_commercial.violations.any, abl.level_commercial.violations_blocked, (abl.level_commercial.block_rate * 100).toFixed(1) + '%'],
    ['+ training_opt_out', abl.level_commercial_training.total_notifications, abl.level_commercial_training.violations.any, abl.level_commercial_training.violations_blocked, (abl.level_commercial_training.block_rate * 100).toFixed(1) + '%'],
    ['All dimensions', abl.all_dimensions.total_notifications, abl.all_dimensions.violations.any, abl.all_dimensions.violations_blocked, (abl.all_dimensions.block_rate * 100).toFixed(1) + '%'],
  ];
  for (const [label, notifs, viols, blocked, rate] of rows) {
    w(`  ${label.padEnd(23)} | ${String(notifs).padStart(6)} | ${String(viols).padStart(10)} | ${String(blocked).padStart(7)} | ${String(rate).padStart(9)}`);
  }

  w('\n  Violation breakdown (ungoverned):');
  const uv = abl.ungoverned.violations;
  w(`    Level: ${uv.level}, Commercial: ${uv.commercial}, Training: ${uv.training}, Scientific: ${uv.scientific_only}, Jurisdiction: ${uv.jurisdiction}`);

  // Table 5: Curation Guarantee
  w('\n--- Table 5: Curation Guarantee ---');
  const cur = results.curation_guarantee;
  w(`  Chunk counts: ${cur.chunk_counts.current} current, ${cur.chunk_counts.proposed} proposed`);
  w(`  Sample: ${cur.chunk_counts.sample_size} chunks (${cur.chunk_counts.sample_current} current, ${cur.chunk_counts.sample_proposed} proposed)\n`);

  w('  Mode                | Total Notifs | From Current | From Proposed');
  w('  --------------------+--------------+--------------+--------------');
  w(`  With curation       | ${String(cur.with_curation.total_notifications).padStart(12)} | ${String(cur.with_curation.from_current).padStart(12)} | ${String(cur.with_curation.from_proposed).padStart(13)}`);
  w(`  Without curation    | ${String(cur.without_curation.total_notifications).padStart(12)} | ${String(cur.without_curation.from_current).padStart(12)} | ${String(cur.without_curation.from_proposed).padStart(13)}`);

  w(`\n  Unvalidated leak: ${cur.unvalidated_leak.notifications_from_proposed} notifications from PROPOSED chunks`);
  w(`  Leak rate: ${(cur.unvalidated_leak.leak_rate * 100).toFixed(1)}% of without-curation notifications come from unvalidated content`);
  w(`  Prevented by curation: ${cur.unvalidated_leak.prevented_by_curation} unvalidated notifications blocked`);

  w('\n========================================\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  try {
    const results = await runBenchmark();
    printSummary(results);

    const jsonOutput = JSON.stringify(results, null, 2);
    process.stdout.write(jsonOutput + '\n');

    const outPath = path.join(__dirname, 'pasa-v2-results.json');
    fs.writeFileSync(outPath, jsonOutput);
    process.stderr.write(`Results saved to ${outPath}\n`);

    process.exit(0);
  } catch (err) {
    process.stderr.write(`\n[FATAL] ${err.message}\n${err.stack}\n`);
    process.exit(1);
  }
})();
