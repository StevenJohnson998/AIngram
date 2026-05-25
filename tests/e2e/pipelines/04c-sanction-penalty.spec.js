// @ts-check
/**
 * 04c — Sanction Penalties on Reputation
 *
 * Verifies: validated flags and sanctions add β penalty to reputation,
 * with linear decay over time. Bans do not decay.
 */

const { test, expect } = require('@playwright/test');
const {
  createUserInDB, createTopicInDB,
  unique, queryDB, execInAPI,
} = require('./helpers');

function createChunkOnDate(topicId, authorId, dateExpr) {
  const content = `Penalty test chunk ${unique()}`.replace(/'/g, "''");
  return execInAPI(`
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    (async () => {
      const r = await pool.query(
        "INSERT INTO chunks (content, created_by, trust_score, status, created_at) VALUES ($1,$2,0.5,'published',${dateExpr}) RETURNING id",
        ['${content}', '${authorId}']
      );
      const chunkId = r.rows[0].id;
      await pool.query("INSERT INTO chunk_topics (chunk_id, topic_id) VALUES ($1,$2)", [chunkId, '${topicId}']);
      console.log(JSON.stringify(chunkId));
      await pool.end();
    })();
  `);
}

function createFlag(targetId, reporterId, dateExpr = 'now()') {
  queryDB(`INSERT INTO flags (reporter_id, target_type, target_id, reason, detection_type, status, created_at) VALUES ('${reporterId}', 'account', '${targetId}', 'test flag', 'manual', 'actioned', ${dateExpr})`);
}

function createSanction(accountId, type, dateExpr = 'now()') {
  queryDB(`INSERT INTO sanctions (account_id, severity, type, reason, issued_by, issued_at, active) VALUES ('${accountId}', 'minor', '${type}', 'test sanction', '${accountId}', ${dateExpr}, true)`);
}

function recalcReputation(accountId) {
  execInAPI(`
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

test.describe.serial('Sanction Penalties', () => {
  let author, reporter, topic;

  test.beforeAll(async () => {
    author = createUserInDB({
      prefix: 'e2e-penalty',
      createdAt: "now() - interval '60 days'",
    });
    reporter = createUserInDB({ prefix: 'e2e-reporter' });
    topic = createTopicInDB(author.id);
    // Give the author some momentum (10 chunks across 2 days)
    for (let d = 1; d <= 2; d++) {
      for (let i = 0; i < 5; i++) {
        createChunkOnDate(topic.id, author.id, `now() - interval '${d * 7} days'`);
      }
    }
  });

  test('baseline: author with momentum has rep > 0.7', () => {
    recalcReputation(author.id);
    const rep = getReputation(author.id);
    // 10 effective chunks → momentum = 1.5 → α = 2.5, β = 1 → rep ≈ 0.714
    expect(rep).toBeGreaterThan(0.70);
    expect(rep).toBeLessThan(0.75);
  });

  test('validated flag reduces reputation', () => {
    createFlag(author.id, reporter.id);
    recalcReputation(author.id);
    const rep = getReputation(author.id);
    // penalty = 1.0 → β = 2.0 → rep = 2.5/4.5 ≈ 0.556
    expect(rep).toBeGreaterThan(0.50);
    expect(rep).toBeLessThan(0.60);
  });

  test('vote suspension stacks with flag penalty', () => {
    createSanction(author.id, 'vote_suspension');
    recalcReputation(author.id);
    const rep = getReputation(author.id);
    // penalty = 1.0 (flag) + 3.0 (suspension) = 4.0 → β = 5.0 → rep = 2.5/7.5 ≈ 0.333
    expect(rep).toBeGreaterThan(0.30);
    expect(rep).toBeLessThan(0.40);
  });

  test('ban destroys reputation even with momentum', () => {
    createSanction(author.id, 'ban');
    recalcReputation(author.id);
    const rep = getReputation(author.id);
    // penalty = 1.0 + 3.0 + 20.0 = 24.0 → β = 25.0 → rep = 2.5/27.5 ≈ 0.091
    expect(rep).toBeLessThan(0.15);
  });

  test('old flag decays over time', () => {
    // Create a separate account with only an old flag (90 days ago)
    const decayAuthor = createUserInDB({
      prefix: 'e2e-decay',
      createdAt: "now() - interval '120 days'",
    });
    const decayTopic = createTopicInDB(decayAuthor.id);
    for (let i = 0; i < 5; i++) {
      createChunkOnDate(decayTopic.id, decayAuthor.id, `now() - interval '${30 + i} days'`);
    }
    createFlag(decayAuthor.id, reporter.id, "now() - interval '90 days'");
    recalcReputation(decayAuthor.id);
    const rep = getReputation(decayAuthor.id);
    // 5 eff chunks → momentum = 0.75 → α = 1.75
    // Flag at 90 days: penalty = 1.0 * (1 - 90/180) = 0.5 → β = 1.5
    // rep = 1.75/3.25 ≈ 0.538
    expect(rep).toBeGreaterThan(0.50);
    expect(rep).toBeLessThan(0.60);
  });

  test('fully decayed flag has no effect', () => {
    const cleanAuthor = createUserInDB({
      prefix: 'e2e-clean',
      createdAt: "now() - interval '365 days'",
    });
    const cleanTopic = createTopicInDB(cleanAuthor.id);
    for (let i = 0; i < 5; i++) {
      createChunkOnDate(cleanTopic.id, cleanAuthor.id, `now() - interval '${200 + i} days'`);
    }
    // Flag from 200 days ago → fully decayed (> 180 days)
    createFlag(cleanAuthor.id, reporter.id, "now() - interval '200 days'");
    recalcReputation(cleanAuthor.id);
    const rep = getReputation(cleanAuthor.id);
    // penalty = 0 → same as no flag
    // 5 eff chunks → momentum = 0.75 → α = 1.75, β = 1 → rep ≈ 0.636
    expect(rep).toBeGreaterThan(0.60);
    expect(rep).toBeLessThan(0.67);
  });
});
