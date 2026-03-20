#!/usr/bin/env node
/**
 * PASA Benchmark — Policy-Aware Semantic Alerting
 *
 * Evaluates governance-aware vector subscriptions for the short paper.
 * Runs against the live AIngram test database using real pgvector + HNSW indexes
 * and real bge-m3 embeddings via Ollama.
 *
 * Usage (inside container):
 *   node benchmarks/pasa.js
 *
 * Usage (from host):
 *   docker exec aingram-api-test node benchmarks/pasa.js
 *
 * Output: JSON results to stdout + human-readable summary to stderr.
 * Also writes results to benchmarks/pasa-results.json.
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

// Subscription count tiers for scalability test
const SCALABILITY_TIERS = [10, 50, 100, 500];

// ---------------------------------------------------------------------------
// Domain-specific content templates for realistic embeddings
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

/** Cosine similarity between two arrays */
function cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Generate an embedding via Ollama bge-m3 */
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

/** Batch-generate embeddings with progress reporting */
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

function median(arr) {
  return percentile(arr, 50);
}

// ---------------------------------------------------------------------------
// Generate synthetic content
// ---------------------------------------------------------------------------

function generateChunkTexts(count) {
  const texts = [];
  const meta = []; // {domain, sensitivity}
  const chunksPerDomain = Math.floor(count / DOMAINS.length);

  for (const domain of DOMAINS) {
    const templates = DOMAIN_TEMPLATES[domain].topics;
    for (let i = 0; i < chunksPerDomain; i++) {
      const base = templates[i % templates.length];
      // Add variation so embeddings are distinct but domain-clustered
      const variation = `${base}. Finding ${i + 1}: ${generateVariation(domain, i)}`;
      // Sensitivity: distribute across levels, skewed by domain
      const sensitivity = assignSensitivity(domain, i, chunksPerDomain);
      texts.push(variation);
      meta.push({ domain, sensitivity });
    }
  }

  return { texts, meta };
}

function generateVariation(domain, index) {
  const adjectives = ['novel', 'critical', 'emerging', 'significant', 'preliminary', 'definitive', 'unexpected', 'validated'];
  const verbs = ['demonstrates', 'reveals', 'confirms', 'challenges', 'extends', 'quantifies', 'identifies', 'establishes'];
  const adj = adjectives[index % adjectives.length];
  const verb = verbs[(index * 3) % verbs.length];
  return `This ${adj} research ${verb} important implications for the ${domain.replace('_', ' ')} domain.`;
}

function assignSensitivity(domain, index, total) {
  // Medical and financial have more high-sensitivity content
  // AI safety and cybersecurity moderate, climate mostly low
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

function generateAgents(count) {
  const agents = [];
  const agentsPerLevel = Math.floor(count / 5);
  for (let i = 0; i < count; i++) {
    const level = Math.min(5, Math.floor(i / agentsPerLevel) + 1);
    const domain = DOMAINS[i % DOMAINS.length];
    const numSubs = randInt(1, 3);
    agents.push({ index: i, level, domain, numSubs });
  }
  return agents;
}

// ---------------------------------------------------------------------------
// Database operations — uses a dedicated schema prefix for isolation
// ---------------------------------------------------------------------------

const BENCH_PREFIX = 'pasa_bench_';

async function setupBenchmarkData(pool, chunkTexts, chunkMeta, chunkEmbeddings, agents) {
  const client = await pool.connect();
  try {
    // Create benchmark-specific temporary tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${BENCH_PREFIX}chunks (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        domain VARCHAR(50) NOT NULL,
        sensitivity INT NOT NULL,
        embedding vector(${EMBEDDING_DIM})
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${BENCH_PREFIX}agents (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        data_handling_level INT NOT NULL,
        domain VARCHAR(50) NOT NULL
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
      const vecStr = `[${chunkEmbeddings[i].join(',')}]`;
      await client.query(
        `INSERT INTO ${BENCH_PREFIX}chunks (content, domain, sensitivity, embedding) VALUES ($1, $2, $3, $4::vector)`,
        [chunkTexts[i], chunkMeta[i].domain, chunkMeta[i].sensitivity, vecStr]
      );
    }

    // Insert agents
    process.stderr.write('  Inserting agents...\n');
    for (const agent of agents) {
      await client.query(
        `INSERT INTO ${BENCH_PREFIX}agents (name, data_handling_level, domain) VALUES ($1, $2, $3)`,
        [`agent_${agent.index}`, agent.level, agent.domain]
      );
    }

    // Create HNSW index on chunk embeddings
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${BENCH_PREFIX}chunks_emb_idx
      ON ${BENCH_PREFIX}chunks USING hnsw (embedding vector_cosine_ops)
    `);

    // Create HNSW index on subscription embeddings
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
// Matching functions — these use the REAL pgvector infrastructure
// ---------------------------------------------------------------------------

/**
 * GOVERNED matching: similarity + policy filter (the paper's contribution).
 * Uses pgvector cosine distance operator in a single query.
 */
async function matchGoverned(pool, chunkId) {
  const { rows } = await pool.query(
    `SELECT s.id as subscription_id, s.agent_id, s.max_sensitivity, s.domain,
            1 - (s.embedding <=> c.embedding) as similarity,
            c.sensitivity as chunk_sensitivity
     FROM ${BENCH_PREFIX}subscriptions s, ${BENCH_PREFIX}chunks c
     WHERE c.id = $1
       AND s.active = true
       AND s.embedding IS NOT NULL
       AND 1 - (s.embedding <=> c.embedding) >= s.similarity_threshold
       AND c.sensitivity <= s.max_sensitivity`,
    [chunkId]
  );
  return rows.map(r => ({
    subscriptionId: r.subscription_id,
    agentId: r.agent_id,
    similarity: parseFloat(r.similarity),
    chunkSensitivity: r.chunk_sensitivity,
    maxSensitivity: r.max_sensitivity,
  }));
}

/**
 * UNGOVERNED matching: similarity only, no policy filter.
 */
async function matchUngoverned(pool, chunkId) {
  const { rows } = await pool.query(
    `SELECT s.id as subscription_id, s.agent_id, s.max_sensitivity, s.domain,
            1 - (s.embedding <=> c.embedding) as similarity,
            c.sensitivity as chunk_sensitivity
     FROM ${BENCH_PREFIX}subscriptions s, ${BENCH_PREFIX}chunks c
     WHERE c.id = $1
       AND s.active = true
       AND s.embedding IS NOT NULL
       AND 1 - (s.embedding <=> c.embedding) >= s.similarity_threshold`,
    [chunkId]
  );
  return rows.map(r => ({
    subscriptionId: r.subscription_id,
    agentId: r.agent_id,
    similarity: parseFloat(r.similarity),
    chunkSensitivity: r.chunk_sensitivity,
    maxSensitivity: r.max_sensitivity,
  }));
}

/**
 * KEYWORD matching: baseline using ILIKE on chunk content.
 */
async function matchKeyword(pool, chunkId, keywordSubs) {
  const { rows: chunkRows } = await pool.query(
    `SELECT id, content, sensitivity FROM ${BENCH_PREFIX}chunks WHERE id = $1`,
    [chunkId]
  );
  if (chunkRows.length === 0) return [];
  const chunk = chunkRows[0];

  const matches = [];
  for (const sub of keywordSubs) {
    for (const kw of sub.keywords) {
      if (chunk.content.toLowerCase().includes(kw.toLowerCase())) {
        matches.push({
          subscriptionId: sub.id,
          agentId: sub.agentId,
          keyword: kw,
          chunkSensitivity: chunk.sensitivity,
          maxSensitivity: sub.maxSensitivity,
        });
        break; // one match per subscription is enough
      }
    }
  }
  return matches;
}

/**
 * Brute-force ground truth: compute exact cosine similarity for ALL
 * subscription-chunk pairs. This is the reference for precision/recall.
 */
async function computeGroundTruth(pool, chunkId, governed) {
  // Get chunk embedding and sensitivity
  const { rows: chunkRows } = await pool.query(
    `SELECT id, embedding, sensitivity FROM ${BENCH_PREFIX}chunks WHERE id = $1`,
    [chunkId]
  );
  if (chunkRows.length === 0) return [];
  const chunk = chunkRows[0];

  // Get all active subscriptions with their raw embeddings
  const { rows: subs } = await pool.query(
    `SELECT id, agent_id, embedding, similarity_threshold, max_sensitivity
     FROM ${BENCH_PREFIX}subscriptions WHERE active = true AND embedding IS NOT NULL`
  );

  // Compute exact cosine similarity (using pgvector's exact computation)
  const { rows: exactMatches } = await pool.query(
    `SELECT s.id as subscription_id, s.agent_id, s.max_sensitivity,
            1 - (s.embedding <=> c.embedding) as similarity,
            c.sensitivity as chunk_sensitivity
     FROM ${BENCH_PREFIX}subscriptions s, ${BENCH_PREFIX}chunks c
     WHERE c.id = $1
       AND s.active = true
       AND s.embedding IS NOT NULL`,
    [chunkId]
  );

  // Filter by threshold (and optionally policy)
  return exactMatches.filter(m => {
    const sim = parseFloat(m.similarity);
    const aboveThreshold = sim >= SIMILARITY_THRESHOLD;
    if (!aboveThreshold) return false;
    if (governed) {
      return m.chunk_sensitivity <= m.max_sensitivity;
    }
    return true;
  }).map(m => ({
    subscriptionId: m.subscription_id,
    agentId: m.agent_id,
    similarity: parseFloat(m.similarity),
    chunkSensitivity: m.chunk_sensitivity,
    maxSensitivity: m.max_sensitivity,
  }));
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

async function runBenchmark() {
  process.stderr.write('=== PASA Benchmark ===\n\n');

  // Connect to the AIngram test database
  const pool = new Pool({
    host: process.env.DB_HOST || 'postgres',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'aingram_test',
    user: process.env.DB_USER || 'admin',
    password: process.env.DB_PASSWORD || '',
    max: 5,
  });

  // Verify pgvector
  try {
    await pool.query('SELECT 1');
    process.stderr.write('[OK] Database connected\n');
  } catch (err) {
    process.stderr.write(`[FAIL] Database connection: ${err.message}\n`);
    process.exit(1);
  }

  // Verify Ollama
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

  // Cleanup any previous benchmark data
  await cleanupBenchmarkData(pool);

  const results = {};

  try {
    // -----------------------------------------------------------------------
    // Phase 1: Generate synthetic data
    // -----------------------------------------------------------------------
    process.stderr.write('\n--- Phase 1: Generating synthetic data ---\n');

    const { texts: chunkTexts, meta: chunkMeta } = generateChunkTexts(NUM_CHUNKS);
    process.stderr.write(`  ${chunkTexts.length} chunk texts generated across ${DOMAINS.length} domains\n`);

    const agents = generateAgents(NUM_AGENTS);
    process.stderr.write(`  ${agents.length} agents generated\n`);

    // Generate embeddings for chunks
    process.stderr.write('  Generating chunk embeddings (this will take a few minutes)...\n');
    const chunkEmbeddings = await generateEmbeddings(chunkTexts, 'Chunks');

    // Setup benchmark tables with chunk and agent data
    process.stderr.write('  Setting up database tables...\n');
    const setupClient = await setupBenchmarkData(pool, chunkTexts, chunkMeta, chunkEmbeddings, agents);
    setupClient.release();

    // Generate subscription embeddings for agents
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
          maxSensitivity: agent.level, // agent can access up to their own level
          threshold: SIMILARITY_THRESHOLD,
        });
      }
    }

    const subEmbeddings = await generateEmbeddings(subscriptionTexts, 'Subscriptions');

    // Build keyword subscriptions for baseline
    const keywordSubs = [];
    let keywordSubId = 1;
    for (const agent of agents) {
      const kws = DOMAIN_TEMPLATES[agent.domain].keywords;
      keywordSubs.push({
        id: keywordSubId++,
        agentId: agent.index + 1,
        keywords: kws,
        maxSensitivity: agent.level,
      });
    }

    // -----------------------------------------------------------------------
    // Phase 2: Precision/Recall evaluation
    // -----------------------------------------------------------------------
    process.stderr.write('\n--- Phase 2: Precision/Recall evaluation ---\n');

    // Insert all subscriptions
    const allSubs = subscriptionData.map((sd, i) => ({
      agentId: sd.agentIndex + 1, // DB is 1-indexed
      embedding: subEmbeddings[i],
      threshold: sd.threshold,
      maxSensitivity: sd.maxSensitivity,
      domain: sd.domain,
    }));
    await insertSubscriptions(pool, allSubs);
    process.stderr.write(`  ${allSubs.length} vector subscriptions inserted\n`);

    // ANALYZE for query planner
    await pool.query(`ANALYZE ${BENCH_PREFIX}chunks`);
    await pool.query(`ANALYZE ${BENCH_PREFIX}subscriptions`);

    // Sample chunks for evaluation (test on 100 random chunks)
    const sampleSize = Math.min(100, NUM_CHUNKS);
    const { rows: sampleChunks } = await pool.query(
      `SELECT id, sensitivity, domain FROM ${BENCH_PREFIX}chunks ORDER BY RANDOM() LIMIT $1`,
      [sampleSize]
    );

    let governedTP = 0, governedFP = 0, governedFN = 0;
    let ungovernedTP = 0, ungovernedFP = 0, ungovernedFN = 0;
    let keywordTP = 0, keywordFP = 0, keywordFN = 0;
    let governedViolations = 0, ungovernedViolations = 0, keywordViolations = 0;
    let totalGroundTruthGoverned = 0, totalGroundTruthUngoverned = 0;

    for (let i = 0; i < sampleChunks.length; i++) {
      const chunk = sampleChunks[i];
      if (i % 20 === 0) process.stderr.write(`\r  Evaluating chunk ${i + 1}/${sampleChunks.length}`);

      // Ground truth (brute-force, governed)
      const gtGoverned = await computeGroundTruth(pool, chunk.id, true);
      const gtUngoverned = await computeGroundTruth(pool, chunk.id, false);
      totalGroundTruthGoverned += gtGoverned.length;
      totalGroundTruthUngoverned += gtUngoverned.length;

      const gtGovernedSet = new Set(gtGoverned.map(m => m.subscriptionId));
      const gtUngovernedSet = new Set(gtUngoverned.map(m => m.subscriptionId));

      // Governed matching
      const governed = await matchGoverned(pool, chunk.id);
      const governedSet = new Set(governed.map(m => m.subscriptionId));
      for (const m of governed) {
        if (gtGovernedSet.has(m.subscriptionId)) governedTP++;
        else governedFP++;
        if (m.chunkSensitivity > m.maxSensitivity) governedViolations++;
      }
      for (const gt of gtGoverned) {
        if (!governedSet.has(gt.subscriptionId)) governedFN++;
      }

      // Ungoverned matching
      const ungoverned = await matchUngoverned(pool, chunk.id);
      const ungovernedSet = new Set(ungoverned.map(m => m.subscriptionId));
      for (const m of ungoverned) {
        // Ground truth for ungoverned = similarity only
        if (gtUngovernedSet.has(m.subscriptionId)) ungovernedTP++;
        else ungovernedFP++;
        if (m.chunkSensitivity > m.maxSensitivity) ungovernedViolations++;
      }
      for (const gt of gtUngoverned) {
        if (!ungovernedSet.has(gt.subscriptionId)) ungovernedFN++;
      }

      // Keyword matching
      const kwMatches = await matchKeyword(pool, chunk.id, keywordSubs);
      for (const m of kwMatches) {
        // For keyword, a TP is one that would also be in the governed ground truth
        if (gtGovernedSet.has(m.subscriptionId)) keywordTP++;
        // We count keyword violations separately
        if (m.chunkSensitivity > m.maxSensitivity) keywordViolations++;
      }
    }
    process.stderr.write('\n');

    const governedPrecision = governedTP / Math.max(1, governedTP + governedFP);
    const governedRecall = governedTP / Math.max(1, governedTP + governedFN);
    const ungovernedPrecision = ungovernedTP / Math.max(1, ungovernedTP + ungovernedFP);
    const ungovernedRecall = ungovernedTP / Math.max(1, ungovernedTP + ungovernedFN);

    // Policy compliance = fraction of notifications where chunk_sensitivity <= max_sensitivity
    const governedTotal = governedTP + governedFP;
    const ungovernedTotal = ungovernedTP + ungovernedFP;
    const governedCompliance = governedTotal > 0 ? (governedTotal - governedViolations) / governedTotal : 1;
    const ungovernedCompliance = ungovernedTotal > 0 ? (ungovernedTotal - ungovernedViolations) / ungovernedTotal : 1;

    results.precision_recall = {
      governed: {
        precision: governedPrecision,
        recall: governedRecall,
        f1: 2 * governedPrecision * governedRecall / Math.max(0.001, governedPrecision + governedRecall),
        total_notifications: governedTotal,
        true_positives: governedTP,
        false_positives: governedFP,
        false_negatives: governedFN,
      },
      ungoverned: {
        precision: ungovernedPrecision,
        recall: ungovernedRecall,
        f1: 2 * ungovernedPrecision * ungovernedRecall / Math.max(0.001, ungovernedPrecision + ungovernedRecall),
        total_notifications: ungovernedTotal,
        true_positives: ungovernedTP,
        false_positives: ungovernedFP,
        false_negatives: ungovernedFN,
      },
      sample_size: sampleSize,
      total_ground_truth_governed: totalGroundTruthGoverned,
      total_ground_truth_ungoverned: totalGroundTruthUngoverned,
    };

    results.policy_compliance = {
      governed: {
        compliance_rate: governedCompliance,
        violations: governedViolations,
        total_notifications: governedTotal,
      },
      ungoverned: {
        compliance_rate: ungovernedCompliance,
        violations: ungovernedViolations,
        total_notifications: ungovernedTotal,
      },
      keyword_baseline: {
        violations: keywordViolations,
      },
    };

    // -----------------------------------------------------------------------
    // Phase 3: Latency measurements
    // -----------------------------------------------------------------------
    process.stderr.write('\n--- Phase 3: Latency measurements ---\n');

    // Use 50 random chunks for latency, repeat 3 times for stability
    const { rows: latencyChunks } = await pool.query(
      `SELECT id FROM ${BENCH_PREFIX}chunks ORDER BY RANDOM() LIMIT 50`
    );

    const governedLatencies = [];
    const ungovernedLatencies = [];

    for (const chunk of latencyChunks) {
      const t0 = process.hrtime.bigint();
      await matchGoverned(pool, chunk.id);
      const t1 = process.hrtime.bigint();
      governedLatencies.push(Number(t1 - t0) / 1e6); // ms

      const t2 = process.hrtime.bigint();
      await matchUngoverned(pool, chunk.id);
      const t3 = process.hrtime.bigint();
      ungovernedLatencies.push(Number(t3 - t2) / 1e6);
    }

    results.latency = {
      subscription_count: allSubs.length,
      governed: {
        p50_ms: percentile(governedLatencies, 50),
        p95_ms: percentile(governedLatencies, 95),
        mean_ms: governedLatencies.reduce((a, b) => a + b, 0) / governedLatencies.length,
      },
      ungoverned: {
        p50_ms: percentile(ungovernedLatencies, 50),
        p95_ms: percentile(ungovernedLatencies, 95),
        mean_ms: ungovernedLatencies.reduce((a, b) => a + b, 0) / ungovernedLatencies.length,
      },
      overhead_pct: (() => {
        const gMean = governedLatencies.reduce((a, b) => a + b, 0) / governedLatencies.length;
        const uMean = ungovernedLatencies.reduce((a, b) => a + b, 0) / ungovernedLatencies.length;
        return ((gMean - uMean) / uMean) * 100;
      })(),
    };

    // -----------------------------------------------------------------------
    // Phase 4: Scalability — latency vs subscription count
    // -----------------------------------------------------------------------
    process.stderr.write('\n--- Phase 4: Scalability ---\n');

    results.scalability = [];

    // First, clear existing subscriptions
    await pool.query(`DELETE FROM ${BENCH_PREFIX}subscriptions`);

    for (const tier of SCALABILITY_TIERS) {
      process.stderr.write(`  Testing with ${tier} subscriptions...\n`);

      // Clear and re-insert subscriptions up to tier count
      await pool.query(`DELETE FROM ${BENCH_PREFIX}subscriptions`);
      const tierSubs = allSubs.slice(0, Math.min(tier, allSubs.length));

      // If we need more subscriptions than we have, duplicate with slight variations
      const subsToInsert = [];
      for (let i = 0; i < tier; i++) {
        const baseSub = tierSubs[i % tierSubs.length];
        subsToInsert.push(baseSub);
      }
      await insertSubscriptions(pool, subsToInsert);
      await pool.query(`ANALYZE ${BENCH_PREFIX}subscriptions`);

      // Measure latency over 30 random chunks
      const { rows: scalChunks } = await pool.query(
        `SELECT id FROM ${BENCH_PREFIX}chunks ORDER BY RANDOM() LIMIT 30`
      );

      const latencies = [];
      for (const chunk of scalChunks) {
        const t0 = process.hrtime.bigint();
        await matchGoverned(pool, chunk.id);
        const t1 = process.hrtime.bigint();
        latencies.push(Number(t1 - t0) / 1e6);
      }

      results.scalability.push({
        subscription_count: tier,
        actual_count: subsToInsert.length,
        p50_ms: percentile(latencies, 50),
        p95_ms: percentile(latencies, 95),
        mean_ms: latencies.reduce((a, b) => a + b, 0) / latencies.length,
        min_ms: Math.min(...latencies),
        max_ms: Math.max(...latencies),
      });
    }

    // -----------------------------------------------------------------------
    // Phase 5: Adversarial — subscription escalation check
    // -----------------------------------------------------------------------
    process.stderr.write('\n--- Phase 5: Adversarial checks ---\n');

    // Test: if an agent with level 2 somehow gets a subscription with max_sensitivity=5,
    // does governed matching still protect?
    await pool.query(`DELETE FROM ${BENCH_PREFIX}subscriptions`);

    // Re-insert normal subscriptions
    await insertSubscriptions(pool, allSubs);

    // Count how many governed matches would have been violations without governance
    let wouldBeViolations = 0;
    let actualViolationsAfterGovernance = 0;
    const advSample = sampleChunks.slice(0, 50);

    for (const chunk of advSample) {
      const ungov = await matchUngoverned(pool, chunk.id);
      const gov = await matchGoverned(pool, chunk.id);

      for (const m of ungov) {
        if (m.chunkSensitivity > m.maxSensitivity) wouldBeViolations++;
      }
      for (const m of gov) {
        if (m.chunkSensitivity > m.maxSensitivity) actualViolationsAfterGovernance++;
      }
    }

    results.adversarial = {
      sample_size: advSample.length,
      ungoverned_would_be_violations: wouldBeViolations,
      governed_actual_violations: actualViolationsAfterGovernance,
      violations_prevented: wouldBeViolations - actualViolationsAfterGovernance,
      prevention_rate: wouldBeViolations > 0
        ? (wouldBeViolations - actualViolationsAfterGovernance) / wouldBeViolations
        : 1.0,
    };

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------
    results.config = {
      num_chunks: NUM_CHUNKS,
      num_agents: NUM_AGENTS,
      domains: DOMAINS,
      similarity_threshold: SIMILARITY_THRESHOLD,
      embedding_model: EMBEDDING_MODEL,
      embedding_dim: EMBEDDING_DIM,
      total_subscriptions: allSubs.length,
      scalability_tiers: SCALABILITY_TIERS,
      timestamp: new Date().toISOString(),
    };

  } finally {
    // Always cleanup
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
  w('  PASA Benchmark Results');
  w('========================================\n');

  w(`Config: ${results.config.num_chunks} chunks, ${results.config.num_agents} agents, ${results.config.total_subscriptions} subscriptions`);
  w(`Model: ${results.config.embedding_model} (${results.config.embedding_dim}d), threshold: ${results.config.similarity_threshold}\n`);

  w('--- Precision / Recall ---');
  const pr = results.precision_recall;
  w(`  Governed:   P=${pr.governed.precision.toFixed(4)}  R=${pr.governed.recall.toFixed(4)}  F1=${pr.governed.f1.toFixed(4)}  (${pr.governed.total_notifications} notifications)`);
  w(`  Ungoverned: P=${pr.ungoverned.precision.toFixed(4)}  R=${pr.ungoverned.recall.toFixed(4)}  F1=${pr.ungoverned.f1.toFixed(4)}  (${pr.ungoverned.total_notifications} notifications)`);
  w(`  Ground truth (governed): ${pr.total_ground_truth_governed} total matches over ${pr.sample_size} chunks`);
  w(`  Ground truth (ungoverned): ${pr.total_ground_truth_ungoverned} total matches\n`);

  w('--- Policy Compliance ---');
  const pc = results.policy_compliance;
  w(`  Governed:   ${(pc.governed.compliance_rate * 100).toFixed(1)}% compliant (${pc.governed.violations} violations / ${pc.governed.total_notifications} notifications)`);
  w(`  Ungoverned: ${(pc.ungoverned.compliance_rate * 100).toFixed(1)}% compliant (${pc.ungoverned.violations} violations / ${pc.ungoverned.total_notifications} notifications)`);
  w(`  Keyword:    ${pc.keyword_baseline.violations} violations\n`);

  w('--- Latency (all subscriptions) ---');
  const lat = results.latency;
  w(`  Governed:   p50=${lat.governed.p50_ms.toFixed(2)}ms  p95=${lat.governed.p95_ms.toFixed(2)}ms  mean=${lat.governed.mean_ms.toFixed(2)}ms`);
  w(`  Ungoverned: p50=${lat.ungoverned.p50_ms.toFixed(2)}ms  p95=${lat.ungoverned.p95_ms.toFixed(2)}ms  mean=${lat.ungoverned.mean_ms.toFixed(2)}ms`);
  w(`  Governance overhead: ${lat.overhead_pct.toFixed(1)}%\n`);

  w('--- Scalability ---');
  w('  Subs  | p50 (ms) | p95 (ms) | mean (ms)');
  w('  ------+----------+----------+----------');
  for (const s of results.scalability) {
    w(`  ${String(s.subscription_count).padStart(5)} | ${s.p50_ms.toFixed(2).padStart(8)} | ${s.p95_ms.toFixed(2).padStart(8)} | ${s.mean_ms.toFixed(2).padStart(9)}`);
  }

  w('\n--- Adversarial ---');
  const adv = results.adversarial;
  w(`  Ungoverned would-be violations: ${adv.ungoverned_would_be_violations}`);
  w(`  Governed actual violations: ${adv.governed_actual_violations}`);
  w(`  Violations prevented: ${adv.violations_prevented} (${(adv.prevention_rate * 100).toFixed(1)}% prevention rate)`);

  w('\n========================================\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  try {
    const results = await runBenchmark();
    printSummary(results);

    // Write JSON results
    const jsonOutput = JSON.stringify(results, null, 2);
    process.stdout.write(jsonOutput + '\n');

    // Also save to file
    const outPath = path.join(__dirname, 'pasa-results.json');
    fs.writeFileSync(outPath, jsonOutput);
    process.stderr.write(`Results saved to ${outPath}\n`);

    process.exit(0);
  } catch (err) {
    process.stderr.write(`\n[FATAL] ${err.message}\n${err.stack}\n`);
    process.exit(1);
  }
})();
