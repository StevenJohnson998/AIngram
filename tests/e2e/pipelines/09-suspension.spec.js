// @ts-check
/**
 * 09 — Vote Suspension Enforcement
 *
 * Verifies that accounts with an active vote_suspension sanction
 * cannot cast informal or formal votes.
 */

const { test, expect } = require('@playwright/test');
const {
  BASE, apiAuth, createUserInDB, createTopicInDB, createChunkInDB,
  createSanctionInDB, unique, queryDB, execInAPI,
} = require('./helpers');

test.describe('Vote Suspension Enforcement', () => {
  let suspendedUser, otherUser, topic, chunkId;

  test.beforeAll(async () => {
    // Create a user who will be suspended
    suspendedUser = createUserInDB({ prefix: 'e2e-susp' });
    // Create another user to own the content
    otherUser = createUserInDB({ prefix: 'e2e-susp-other' });
    // Create content to vote on
    topic = createTopicInDB(otherUser.id);
    chunkId = createChunkInDB(topic.id, otherUser.id,
      `Suspension test chunk with sufficient content length ${unique()}`);
    // Apply vote suspension
    createSanctionInDB(suspendedUser.id, { type: 'vote_suspension', severity: 'minor' });
  });

  test('informal vote blocked with 403 VOTE_SUSPENDED', async ({ request }) => {
    const res = await request.post(`${BASE}/v1/votes`, {
      headers: apiAuth(suspendedUser),
      data: {
        target_type: 'chunk',
        target_id: chunkId,
        value: 'up',
        reason_tag: 'accurate',
      },
    });

    expect(res.status()).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe('VOTE_SUSPENDED');
  });

  test('formal vote commit blocked with 403 VOTE_SUSPENDED', async ({ request }) => {
    // Create a fresh chunk in under_review/commit phase for formal voting
    const formalChunkId = createChunkInDB(topic.id, otherUser.id,
      `Formal vote suspension test chunk ${unique()}`,
      { status: 'under_review' });
    // Set vote_phase and deadline via execInAPI (avoids SQL escaping issues)
    execInAPI(`
      const { Pool } = require('pg');
      const pool = new Pool({ host: process.env.DB_HOST || 'postgres', database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
      (async () => {
        await pool.query(
          "UPDATE chunks SET vote_phase = 'commit', commit_deadline_at = now() + interval '1 hour', reveal_deadline_at = now() + interval '2 hours' WHERE id = $1",
          ['${formalChunkId}']
        );
        console.log(JSON.stringify({ ok: true }));
        await pool.end();
      })();
    `);

    const commitHash = require('crypto').randomBytes(32).toString('hex');
    const res = await request.post(`${BASE}/v1/votes/formal/commit`, {
      headers: apiAuth(suspendedUser),
      data: {
        chunk_id: formalChunkId,
        commit_hash: commitHash,
      },
    });

    expect(res.status()).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe('VOTE_SUSPENDED');
  });
});
