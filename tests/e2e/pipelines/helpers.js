// @ts-check
/**
 * Shared E2E pipeline test helpers.
 * Extracted from full-platform.spec.js + new pipeline-specific utilities.
 */

const crypto = require('crypto');
const { execSync } = require('child_process');

const BASE = process.env.BASE_URL || 'http://172.18.0.19:3000';
const API_CONTAINER = process.env.API_CONTAINER || 'aingram-api-test';
const DB_CONTAINER = process.env.DB_CONTAINER || 'postgres';
const DB_NAME = 'aingram_test';

const unique = () => crypto.randomBytes(4).toString('hex');

// ─── Auth ────────────────────────────────────────────────────────────

/** Return auth header for API key auth. */
function apiAuth(user) {
  return { Authorization: `Bearer ${user.apiKey}` };
}

// ─── User creation ───────────────────────────────────────────────────

/**
 * Create a confirmed, active user directly in DB.
 * @param {object} opts
 * @param {number} [opts.tier=0]
 * @param {boolean} [opts.badgePolicing=false]
 * @param {boolean} [opts.badgeContribution=false]
 * @param {number} [opts.reputationContribution=0.5]
 * @param {number} [opts.reputationCopyright=0.5]
 * @param {string} [opts.type='human']
 * @param {string} [opts.prefix='e2e-pipe']
 * @param {string} [opts.createdAt] - SQL expression for created_at (e.g. "now() - interval '60 days'")
 */
function createUserInDB({
  tier = 0,
  badgePolicing = false,
  badgeContribution = false,
  reputationContribution = 0.5,
  reputationCopyright = 0.5,
  type = 'human',
  prefix = 'e2e-pipe',
  createdAt,
} = {}) {
  const id = unique();
  const email = `${prefix}-${id}@example.com`;
  const name = `${prefix} ${id}`;
  const createdAtExpr = createdAt || 'now()';

  const script = `
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    (async () => {
      const accountId = crypto.randomUUID();
      const pwHash = bcrypt.hashSync('TestPass2026!', 10);
      const pfx = crypto.randomBytes(4).toString('hex');
      const secret = crypto.randomBytes(12).toString('hex');
      const keyHash = bcrypt.hashSync(secret, 10);
      await pool.query(
        \`INSERT INTO accounts (id, name, type, owner_email, password_hash, status, email_confirmed, tier,
         badge_policing, badge_contribution, reputation_copyright, reputation_contribution,
         first_contribution_at, terms_version_accepted, api_key_hash, api_key_prefix, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,now(),$12,$13,$14,${createdAtExpr})\`,
        [accountId, '${name}', '${type}', '${email}', pwHash, 'active',
         ${tier}, ${badgePolicing}, ${badgeContribution},
         ${reputationCopyright}, ${reputationContribution},
         '2026-03-21-v1', keyHash, pfx]
      );
      console.log(JSON.stringify({ id: accountId, email: '${email}', apiKey: \`aingram_\${pfx}_\${secret}\` }));
      await pool.end();
    })();
  `;
  const raw = execSync(`docker exec -i ${API_CONTAINER} node`, {
    input: script, encoding: 'utf-8', timeout: 10000,
  }).trim();
  return JSON.parse(raw);
}

/** Create a sub-account (assisted agent) under a parent. */
function createSubAccountInDB(parentId) {
  const name = `Agent-${unique()}`;
  const script = `
    const crypto = require('crypto');
    const bcrypt = require('bcryptjs');
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    (async () => {
      const agentId = crypto.randomUUID();
      const pfx = crypto.randomBytes(4).toString('hex');
      const secret = crypto.randomBytes(12).toString('hex');
      const keyHash = bcrypt.hashSync(secret, 10);
      const parent = await pool.query('SELECT owner_email FROM accounts WHERE id = $1', ['${parentId}']);
      await pool.query(
        \`INSERT INTO accounts (id, name, type, owner_email, parent_id, status, autonomous, tier,
         first_contribution_at, terms_version_accepted, api_key_hash, api_key_prefix)
         VALUES ($1,$2,'ai',$3,$4,'active',false,0,now(),'2026-03-21-v1',$5,$6)\`,
        [agentId, '${name}', parent.rows[0].owner_email, '${parentId}', keyHash, pfx]
      );
      console.log(JSON.stringify({ id: agentId, name: '${name}', apiKey: \`aingram_\${pfx}_\${secret}\` }));
      await pool.end();
    })();
  `;
  const raw = execSync(`docker exec -i ${API_CONTAINER} node`, {
    input: script, encoding: 'utf-8', timeout: 10000,
  }).trim();
  return JSON.parse(raw);
}

// ─── Content creation ────────────────────────────────────────────────

/** Create a topic directly in DB. Returns { id, slug }. */
function createTopicInDB(authorId, opts = {}) {
  const slug = `e2e-topic-${unique()}`;
  const sensitivity = opts.sensitivity || 'low';
  const result = execInAPI(`
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    (async () => {
      const r = await pool.query(
        "INSERT INTO topics (title, slug, lang, summary, sensitivity, created_by) VALUES ($1,$2,'en','Test topic.','${sensitivity}',$3) RETURNING id",
        ['E2E Topic ${slug}', '${slug}', '${authorId}']
      );
      console.log(JSON.stringify({ id: r.rows[0].id, slug: '${slug}' }));
      await pool.end();
    })();
  `);
  return result;
}

/** Create a chunk directly in DB linked to a topic. Returns chunk ID. */
function createChunkInDB(topicId, authorId, content, opts = {}) {
  const status = opts.status || 'published';
  const trustScore = opts.trustScore ?? 0.5;
  const safeContent = (content || `E2E chunk ${Date.now()} ${unique()}`).replace(/'/g, "''");
  const result = execInAPI(`
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    (async () => {
      const r = await pool.query(
        "INSERT INTO chunks (content, created_by, trust_score, status) VALUES ($1,$2,$3,$4) RETURNING id",
        ['${safeContent}', '${authorId}', ${trustScore}, '${status}']
      );
      const chunkId = r.rows[0].id;
      await pool.query("INSERT INTO chunk_topics (chunk_id, topic_id) VALUES ($1,$2)", [chunkId, '${topicId}']);
      console.log(JSON.stringify(chunkId));
      await pool.end();
    })();
  `);
  return result;
}

/** Create a message directly in DB. Returns message ID. */
function createMessageInDB(topicId, accountId, { level = 1, type = 'contribution', content } = {}) {
  const safeContent = (content || `E2E message ${unique()}`).replace(/'/g, "''");
  return queryDB(
    `INSERT INTO messages (topic_id, account_id, level, type, content, status) VALUES ('${topicId}', '${accountId}', ${level}, '${type}', '${safeContent}', 'visible') RETURNING id`
  );
}

/** Create a flag directly in DB. Returns flag ID. */
function createFlagInDB(reporterId, targetType, targetId, reason = 'E2E test flag') {
  return queryDB(
    `INSERT INTO flags (reporter_id, target_type, target_id, reason, detection_type, status) VALUES ('${reporterId}', '${targetType}', '${targetId}', '${reason}', 'manual', 'open') RETURNING id`
  );
}

/** Create a sanction directly in DB. Returns sanction ID. */
function createSanctionInDB(accountId, { type = 'vote_suspension', severity = 'minor', issuedBy } = {}) {
  const issuer = issuedBy || accountId;
  return queryDB(
    `INSERT INTO sanctions (account_id, severity, type, reason, issued_by, active) VALUES ('${accountId}', '${severity}', '${type}', 'E2E test sanction', '${issuer}', true) RETURNING id`
  );
}

// ─── DB queries ──────────────────────────────────────────────────────

/** Run a SQL query via the API container's pg client. Returns raw text output. */
function queryDB(sql) {
  const escapedSql = sql.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/"/g, '\\"');
  const script = `
    const { Pool } = require('pg');
    const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    pool.query("${escapedSql}").then(r => {
      const out = r.rows.map(row => Object.values(row).join('|')).join('\\n');
      console.log(out);
      pool.end();
    }).catch(e => { console.error(e.message); pool.end(); process.exit(1); });
  `;
  return execSync(`docker exec -i ${API_CONTAINER} node`, {
    input: script, encoding: 'utf-8', timeout: 10000,
  }).trim();
}

/** Run a Node script inside the API container. Returns parsed JSON. */
function execInAPI(script) {
  const raw = execSync(`docker exec -i ${API_CONTAINER} node`, {
    input: script, encoding: 'utf-8', timeout: 30000,
  }).trim();
  return JSON.parse(raw);
}

// ─── Convenience queries ─────────────────────────────────────────────

function getChunkTrust(chunkId) {
  return parseFloat(queryDB(`SELECT trust_score FROM chunks WHERE id = '${chunkId}'`));
}

function getChunkStatus(chunkId) {
  return queryDB(`SELECT status FROM chunks WHERE id = '${chunkId}'`);
}

function getAccountBadges(accountId) {
  const raw = queryDB(
    `SELECT badge_contribution, badge_policing, badge_elite FROM accounts WHERE id = '${accountId}'`
  );
  const [c, p, e] = raw.split('|');
  return {
    contribution: c === 'true' || c === 't',
    policing: p === 'true' || p === 't',
    elite: e === 'true' || e === 't',
  };
}

function getAccountStatus(accountId) {
  return queryDB(`SELECT status FROM accounts WHERE id = '${accountId}'`);
}

function getVoteWeights(accountId) {
  const raw = queryDB(
    `SELECT target_id, weight FROM votes WHERE account_id = '${accountId}'`
  );
  if (!raw) return [];
  return raw.split('\n').map(line => {
    const [target_id, weight] = line.split('|');
    return { target_id, weight: parseFloat(weight) };
  });
}

// ─── Timing ──────────────────────────────────────────────────────────

/** Wait for fire-and-forget async operations to complete. */
function waitFF(ms = 800) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
  BASE,
  API_CONTAINER,
  DB_CONTAINER,
  DB_NAME,
  unique,
  apiAuth,
  createUserInDB,
  createSubAccountInDB,
  createTopicInDB,
  createChunkInDB,
  createMessageInDB,
  createFlagInDB,
  createSanctionInDB,
  queryDB,
  execInAPI,
  getChunkTrust,
  getChunkStatus,
  getAccountBadges,
  getAccountStatus,
  getVoteWeights,
  waitFF,
};
