#!/usr/bin/env node

/**
 * AIngram Database Verification Script
 * Checks: connection, schema, pgvector, FTS, seed data counts
 */

require('dotenv').config();
const { getPool, closePool } = require('./database');

const EXPECTED_TABLES = {
  accounts: 20,
  sanctions: 9,
  topics: 15,
  topic_translations: 2,
  chunks: 11,
  chunk_topics: 2,
  chunk_sources: 6,
  messages: 9,
  votes: 8,
  flags: 10,
  subscriptions: 12,
};

const EXPECTED_COUNTS = {
  accounts: 3,
  topics: 10,
  chunks: 30,
  chunk_topics: 30,
  chunk_sources: 5,
  messages: 10,
  votes: 8,
  flags: 3,
  subscriptions: 4,
  topic_translations: 16,
};

let passed = 0;
let failed = 0;

function report(name, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name} -- ${detail}`);
    failed++;
  }
}

async function run() {
  const pool = getPool();

  // 1. Connection
  try {
    await pool.query('SELECT 1');
    report('DB connection', true);
  } catch (err) {
    report('DB connection', false, err.message);
    await closePool();
    process.exit(1);
  }

  // 2. Tables exist with correct column counts
  for (const [table, expectedCols] of Object.entries(EXPECTED_TABLES)) {
    try {
      const res = await pool.query(
        `SELECT count(*) as col_count
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table]
      );
      const colCount = parseInt(res.rows[0].col_count, 10);
      report(
        `Table "${table}" exists (${colCount} columns)`,
        colCount === expectedCols,
        colCount === 0
          ? 'table not found'
          : `expected ${expectedCols} columns, got ${colCount}`
      );
    } catch (err) {
      report(`Table "${table}"`, false, err.message);
    }
  }

  // 3. pgvector works
  try {
    const dim = 1024;
    const testVector = `[${Array(dim).fill(0.1).join(',')}]`;
    const testVector2 = `[${Array(dim).fill(0.2).join(',')}]`;

    await pool.query(
      `CREATE TEMP TABLE _vector_test (id serial, vec vector(${dim}))`
    );
    await pool.query('INSERT INTO _vector_test (vec) VALUES ($1), ($2)', [
      testVector,
      testVector2,
    ]);
    const res = await pool.query(
      "SELECT 1 - (vec <=> $1::vector) as similarity FROM _vector_test ORDER BY vec <=> $1::vector LIMIT 1",
      [testVector]
    );
    const similarity = parseFloat(res.rows[0].similarity);
    await pool.query('DROP TABLE _vector_test');
    report(
      `pgvector cosine similarity (got ${similarity.toFixed(4)})`,
      similarity > 0.99,
      `unexpected similarity: ${similarity}`
    );
  } catch (err) {
    report('pgvector', false, err.message);
  }

  // 4. Full-text search works
  try {
    const res = await pool.query(
      `SELECT count(*) as cnt FROM chunks
       WHERE to_tsvector('english', content) @@ to_tsquery('english', 'transformer')`
    );
    const cnt = parseInt(res.rows[0].cnt, 10);
    report(
      `Full-text search for "transformer" (${cnt} results)`,
      cnt > 0,
      'no results found'
    );
  } catch (err) {
    report('Full-text search', false, err.message);
  }

  // 5. Seed data counts
  for (const [table, expected] of Object.entries(EXPECTED_COUNTS)) {
    try {
      const res = await pool.query(`SELECT count(*) as cnt FROM ${table}`);
      const cnt = parseInt(res.rows[0].cnt, 10);
      report(
        `Seed data "${table}" (${cnt} rows)`,
        cnt === expected,
        `expected ${expected}, got ${cnt}`
      );
    } catch (err) {
      report(`Seed data "${table}"`, false, err.message);
    }
  }

  // Summary
  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
  await closePool();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Verification failed:', err.message);
  process.exit(1);
});
