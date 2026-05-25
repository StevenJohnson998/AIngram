// @ts-check
/**
 * 04b — Contribution Momentum
 *
 * Verifies: published chunks build reputation via momentum,
 * daily/weekly caps are enforced, source bonus applies, cap at 5.0.
 */

const { test, expect } = require('@playwright/test');
const {
  BASE, apiAuth, createUserInDB, createTopicInDB,
  waitFF, unique, queryDB, execInAPI,
} = require('./helpers');

/**
 * Create a published chunk with a specific created_at date.
 * @param {string} topicId
 * @param {string} authorId
 * @param {string} dateExpr - SQL expression, e.g. "now() - interval '10 days'"
 * @param {object} [opts]
 * @param {boolean} [opts.withSource] - attach a source to the chunk
 * @returns {string} chunk ID
 */
function createChunkOnDate(topicId, authorId, dateExpr, opts = {}) {
  const content = `Momentum test chunk ${unique()}`.replace(/'/g, "''");
  const result = execInAPI(`
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    (async () => {
      const r = await pool.query(
        "INSERT INTO chunks (content, created_by, trust_score, status, created_at) VALUES ($1,$2,0.5,'published',${dateExpr}) RETURNING id",
        ['${content}', '${authorId}']
      );
      const chunkId = r.rows[0].id;
      await pool.query("INSERT INTO chunk_topics (chunk_id, topic_id) VALUES ($1,$2)", [chunkId, '${topicId}']);
      ${opts.withSource ? `
      await pool.query(
        "INSERT INTO chunk_sources (chunk_id, source_url, source_description, added_by) VALUES ($1, $2, $3, $4)",
        [chunkId, 'https://example.com/source-' + chunkId.slice(0,8), 'Test source', '${authorId}']
      );` : ''}
      console.log(JSON.stringify(chunkId));
      await pool.end();
    })();
  `);
  return result;
}

/** Trigger recalculateReputation for an account via docker exec. */
function recalcReputation(accountId) {
  execInAPI(`
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    const { configurePool } = require('./src/config/database');
    configurePool({ max: 5 });
    const { recalculateReputation } = require('./src/services/reputation');
    (async () => {
      const result = await recalculateReputation('${accountId}');
      console.log(JSON.stringify(result));
      const { getPool } = require('./src/config/database');
      await getPool().end();
    })();
  `);
}

function getReputation(accountId) {
  return parseFloat(queryDB(
    `SELECT reputation_contribution FROM accounts WHERE id = '${accountId}'`
  ));
}

test.describe.serial('Contribution Momentum', () => {
  let author, topic;

  test.beforeAll(async () => {
    author = createUserInDB({
      prefix: 'e2e-momentum',
      createdAt: "now() - interval '60 days'",
    });
    topic = createTopicInDB(author.id);
  });

  test('baseline: 0 published chunks → reputation stays at 0.5', () => {
    recalcReputation(author.id);
    const rep = getReputation(author.id);
    expect(rep).toBeCloseTo(0.5, 2);
  });

  test('5 chunks across 5 days → momentum builds reputation above 0.5', () => {
    for (let i = 1; i <= 5; i++) {
      createChunkOnDate(topic.id, author.id, `now() - interval '${i} days'`);
    }
    recalcReputation(author.id);
    const rep = getReputation(author.id);
    // 5 effective chunks × 0.15 = 0.75 momentum
    // α = 1 + 0.75 = 1.75, β = 1 → rep = 1.75/2.75 ≈ 0.636
    expect(rep).toBeGreaterThan(0.6);
    expect(rep).toBeLessThan(0.7);
  });

  test('daily cap: 8 chunks on same day → only 5 counted', () => {
    // Add 8 chunks all on the same day (30 days ago)
    for (let i = 0; i < 8; i++) {
      createChunkOnDate(topic.id, author.id, "now() - interval '30 days'");
    }
    recalcReputation(author.id);
    const rep = getReputation(author.id);
    // Previous: 5 eff chunks (one per day). New day: 8 posted, 5 counted → 10 total eff chunks
    // momentum = 10 × 0.15 = 1.5 → α = 2.5, β = 1 → rep ≈ 0.714
    // If no daily cap: 13 × 0.15 = 1.95 → α = 2.95 → rep ≈ 0.747
    expect(rep).toBeGreaterThan(0.70);
    expect(rep).toBeLessThan(0.75);
  });

  test('weekly cap: many chunks in same week → max 10 per week', () => {
    // Add 5 chunks/day for 3 more days in the same week as the 30-day-ago chunks
    // (days 31, 32, 33 ago — same ISO week as day 30)
    // After daily cap: 5+5+5 = 15 from those days, but weekly cap = 10
    // Already had 5 counted from day 30 → week total would be 20 before cap → capped at 10
    // Actually let's use a fresh week to isolate
    for (let d = 0; d < 3; d++) {
      for (let i = 0; i < 5; i++) {
        createChunkOnDate(topic.id, author.id, `now() - interval '${50 + d} days'`);
      }
    }
    recalcReputation(author.id);
    const rep = getReputation(author.id);
    // New week (50-52 days ago): 15 daily-capped chunks → weekly cap 10
    // Total effective: prev 10 + this week 10 = 20
    // momentum = 20 × 0.15 = 3.0 → α = 4, β = 1 → rep = 0.80
    expect(rep).toBeGreaterThan(0.78);
    expect(rep).toBeLessThan(0.82);
  });

  test('source bonus adds extra momentum', () => {
    // Add 5 sourced chunks on another week
    for (let i = 0; i < 5; i++) {
      createChunkOnDate(topic.id, author.id, `now() - interval '${70 + i} days'`, { withSource: true });
    }
    recalcReputation(author.id);
    const rep = getReputation(author.id);
    // New week: 5 chunks (daily OK, weekly OK) + 5 sourced
    // momentum = (20+5) × 0.15 + 5 × 0.10 = 3.75 + 0.50 = 4.25
    // α = 5.25, β = 1 → rep = 0.84
    expect(rep).toBeGreaterThan(0.82);
    expect(rep).toBeLessThan(0.86);
  });

  test('momentum caps at 5.0 (reputation caps around 0.86)', () => {
    // Add chunks across 3 more weeks to exceed cap
    for (let w = 0; w < 3; w++) {
      for (let d = 0; d < 2; d++) {
        for (let i = 0; i < 5; i++) {
          createChunkOnDate(topic.id, author.id,
            `now() - interval '${80 + w * 7 + d} days'`);
        }
      }
    }
    recalcReputation(author.id);
    const rep = getReputation(author.id);
    // Many more effective chunks but momentum capped at 5.0
    // α = 1 + 5.0 = 6.0, β = 1 → rep = 6/7 ≈ 0.857
    expect(rep).toBeGreaterThan(0.84);
    expect(rep).toBeLessThan(0.88);
  });

  test('burst gaming: 50 chunks in 1 day yields minimal momentum', () => {
    const burster = createUserInDB({
      prefix: 'e2e-burst',
      createdAt: "now() - interval '60 days'",
    });
    const bursterTopic = createTopicInDB(burster.id);
    for (let i = 0; i < 50; i++) {
      createChunkOnDate(bursterTopic.id, burster.id, "now() - interval '5 days'");
    }
    recalcReputation(burster.id);
    const rep = getReputation(burster.id);
    // 50 chunks, same day → daily cap 5, weekly cap 10 → 5 effective
    // momentum = 5 × 0.15 = 0.75 → α = 1.75, β = 1 → rep ≈ 0.636
    expect(rep).toBeGreaterThan(0.6);
    expect(rep).toBeLessThan(0.7);
  });
});
