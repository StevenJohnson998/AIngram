/**
 * DB contract tests — run against real PostgreSQL to verify schema constraints.
 * These tests require the aingram_test database to be running.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL ||
  `postgresql://${process.env.DB_USER || 'admin'}:${process.env.DB_PASSWORD || ''}@${process.env.DB_HOST || '172.18.0.4'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'aingram_test'}`;

let pool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

// Helper: create a test account and return its id
async function createTestAccount(name = 'test-account') {
  const { rows } = await pool.query(
    `INSERT INTO accounts (name, type, owner_email, status)
     VALUES ($1, 'ai', $2, 'active')
     RETURNING id`,
    [`${name}-${Date.now()}`, `${name}@test.local`]
  );
  return rows[0].id;
}

describe('votes.target_type CHECK constraint', () => {
  let accountId;

  beforeAll(async () => {
    accountId = await createTestAccount('vote-test');
  });

  it('accepts target_type = chunk', async () => {
    const { rows } = await pool.query(
      `INSERT INTO votes (account_id, target_type, target_id, value, weight)
       VALUES ($1, 'chunk', gen_random_uuid(), 'up', 1.0)
       RETURNING id`,
      [accountId]
    );
    expect(rows[0].id).toBeDefined();
  });

  it('accepts target_type = message', async () => {
    const { rows } = await pool.query(
      `INSERT INTO votes (account_id, target_type, target_id, value, weight)
       VALUES ($1, 'message', gen_random_uuid(), 'up', 1.0)
       RETURNING id`,
      [accountId]
    );
    expect(rows[0].id).toBeDefined();
  });

  it('rejects target_type = invalid', async () => {
    await expect(pool.query(
      `INSERT INTO votes (account_id, target_type, target_id, value, weight)
       VALUES ($1, 'invalid', gen_random_uuid(), 'up', 1.0)`,
      [accountId]
    )).rejects.toThrow(/violates check constraint/);
  });
});

describe('chunks.status CHECK constraint', () => {
  let accountId;

  beforeAll(async () => {
    accountId = await createTestAccount('chunk-test');
  });

  it('accepts status = under_review', async () => {
    const { rows } = await pool.query(
      `INSERT INTO chunks (content, created_by, status)
       VALUES ('test content', $1, 'under_review')
       RETURNING id`,
      [accountId]
    );
    expect(rows[0].id).toBeDefined();
  });

  it('accepts status = proposed', async () => {
    const { rows } = await pool.query(
      `INSERT INTO chunks (content, created_by, status)
       VALUES ('test content proposed', $1, 'proposed')
       RETURNING id`,
      [accountId]
    );
    expect(rows[0].id).toBeDefined();
  });

  it('rejects status = invalid', async () => {
    await expect(pool.query(
      `INSERT INTO chunks (content, created_by, status)
       VALUES ('bad status', $1, 'invalid')`,
      [accountId]
    )).rejects.toThrow(/violates check constraint/);
  });
});

describe('protocol-ready column defaults', () => {
  let accountId;

  beforeAll(async () => {
    accountId = await createTestAccount('defaults-test');
  });

  it('accounts.tier defaults to 0', async () => {
    const { rows } = await pool.query('SELECT tier FROM accounts WHERE id = $1', [accountId]);
    expect(rows[0].tier).toBe(0);
  });

  it('accounts.interaction_count defaults to 0', async () => {
    const { rows } = await pool.query('SELECT interaction_count FROM accounts WHERE id = $1', [accountId]);
    expect(rows[0].interaction_count).toBe(0);
  });

  it('accounts.quarantine_until defaults to null', async () => {
    const { rows } = await pool.query('SELECT quarantine_until FROM accounts WHERE id = $1', [accountId]);
    expect(rows[0].quarantine_until).toBeNull();
  });

  it('chunks.hidden defaults to false', async () => {
    const { rows } = await pool.query(
      `INSERT INTO chunks (content, created_by) VALUES ('hidden test', $1) RETURNING hidden`,
      [accountId]
    );
    expect(rows[0].hidden).toBe(false);
  });

  it('chunks.confidentiality defaults to public', async () => {
    const { rows } = await pool.query(
      `INSERT INTO chunks (content, created_by) VALUES ('conf test', $1) RETURNING confidentiality`,
      [accountId]
    );
    expect(rows[0].confidentiality).toBe('public');
  });
});

describe('COMMENT ON metadata for reserved columns', () => {
  it('has comments on reserved account columns', async () => {
    const { rows } = await pool.query(`
      SELECT col.column_name, pgd.description
      FROM information_schema.columns col
      JOIN pg_catalog.pg_statio_all_tables st ON st.relname = col.table_name AND st.schemaname = col.table_schema
      JOIN pg_catalog.pg_description pgd ON pgd.objoid = st.relid AND pgd.objsubid = col.ordinal_position
      WHERE col.table_name = 'accounts' AND col.column_name IN ('tier', 'reputation_copyright', 'quarantine_until')
      ORDER BY col.column_name
    `);
    const comments = Object.fromEntries(rows.map(r => [r.column_name, r.description]));
    expect(comments.tier).toContain('tier'); // Sprint 1: tier is now enforced, no longer RESERVED
    expect(comments.reputation_copyright).toContain('RESERVED');
    expect(comments.quarantine_until).toContain('RESERVED');
  });

  it('has comment on chunks.confidentiality', async () => {
    const { rows } = await pool.query(`
      SELECT pgd.description
      FROM information_schema.columns col
      JOIN pg_catalog.pg_statio_all_tables st ON st.relname = col.table_name AND st.schemaname = col.table_schema
      JOIN pg_catalog.pg_description pgd ON pgd.objoid = st.relid AND pgd.objsubid = col.ordinal_position
      WHERE col.table_name = 'chunks' AND col.column_name = 'confidentiality'
    `);
    expect(rows[0].description).toContain('RESERVED');
  });
});
