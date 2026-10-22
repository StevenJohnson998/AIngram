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
  createSanctionInDB, unique, queryDB, proposeChangeset,
} = require('./helpers');

test.describe('Vote Suspension Enforcement', () => {
  let suspendedUser, otherUser, controlUser, topic, chunkId;

  test.beforeAll(async () => {
    // Create a user who will be suspended
    suspendedUser = createUserInDB({ prefix: 'e2e-susp' });
    // Create another user to own the content
    otherUser = createUserInDB({ prefix: 'e2e-susp-other' });
    // Non-suspended voter used as a control for the formal vote
    controlUser = createUserInDB({ prefix: 'e2e-susp-ctrl', createdAt: "now() - interval '30 days'" });
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

  // Formal votes target changesets (chunk_id is only a deprecated fallback that resolves
  // through changeset_operations), so the test proposes a real changeset.
  test('formal vote commit blocked with 403 VOTE_SUSPENDED', async ({ request }) => {
    const { changesetId } = await proposeChangeset(request, otherUser, topic.id,
      `Formal vote suspension test chunk with enough content length ${unique()}`);
    queryDB(`UPDATE changesets SET status = 'under_review', vote_phase = 'commit', commit_deadline_at = now() + interval '1 hour', reveal_deadline_at = now() + interval '2 hours' WHERE id = '${changesetId}'`);

    const commit = (user) => request.post(`${BASE}/v1/votes/formal/commit`, {
      headers: apiAuth(user),
      data: { changeset_id: changesetId, commit_hash: require('crypto').randomBytes(32).toString('hex') },
    });

    const res = await commit(suspendedUser);
    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe('VOTE_SUSPENDED');

    // Control: same changeset, same phase, a non-suspended voter is accepted
    const control = await commit(controlUser);
    expect(control.status()).toBe(201);
  });
});
