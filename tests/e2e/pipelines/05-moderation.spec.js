// @ts-check
/**
 * 05 — Moderation Pipeline
 *
 * Verifies: flag → sanction escalation → ban → vote nullification → cascade ban.
 */

const { test, expect } = require('@playwright/test');
const {
  BASE, apiAuth, createUserInDB, createTopicInDB, createChunkInDB,
  createFlagInDB, getAccountStatus, getVoteWeights, getChunkTrust,
  waitFF, unique, queryDB,
} = require('./helpers');

test.describe('Moderation Pipeline', () => {
  let policer, topic;

  test.beforeAll(async () => {
    policer = createUserInDB({ prefix: 'e2e-mod-pol', tier: 2, badgePolicing: true });
    const author = createUserInDB({ prefix: 'e2e-mod-auth' });
    topic = createTopicInDB(author.id);
  });

  test('create flag on chunk', async ({ request }) => {
    const target = createUserInDB({ prefix: 'e2e-mod-target' });
    const chunkId = createChunkInDB(topic.id, target.id, `Flag test chunk ${unique()}`);

    const res = await request.post(`${BASE}/v1/flags`, {
      headers: apiAuth(policer),
      data: {
        targetType: 'chunk',
        targetId: chunkId,
        reason: 'E2E test: content quality concern',
      },
    });

    expect(res.status()).toBe(201);
    const json = await res.json();
    const flag = json.data || json;
    expect(flag.status).toBe('open');
  });

  test('sanction escalation: 1st minor → vote_suspension', async ({ request }) => {
    const offender = createUserInDB({ prefix: 'e2e-mod-off1' });

    const res = await request.post(`${BASE}/v1/sanctions`, {
      headers: apiAuth(policer),
      data: {
        accountId: offender.id,
        severity: 'minor',
        reason: 'E2E test: first offense',
      },
    });

    expect(res.status()).toBe(201);
    const json = await res.json();
    const sanction = json.data || json;
    expect(sanction.type).toBe('vote_suspension');
  });

  test('sanction escalation: 2nd minor → rate_limit', async ({ request }) => {
    const offender = createUserInDB({ prefix: 'e2e-mod-off2' });
    // Create first sanction directly in DB
    queryDB(`INSERT INTO sanctions (account_id, severity, type, reason, issued_by, active) VALUES ('${offender.id}', 'minor', 'vote_suspension', 'prior', '${policer.id}', true)`);

    const res = await request.post(`${BASE}/v1/sanctions`, {
      headers: apiAuth(policer),
      data: {
        accountId: offender.id,
        severity: 'minor',
        reason: 'E2E test: second offense',
      },
    });

    expect(res.status()).toBe(201);
    const json = await res.json();
    const sanction = json.data || json;
    expect(sanction.type).toBe('rate_limit');
  });

  test('grave offense → ban, account status = banned', async ({ request }) => {
    const offender = createUserInDB({ prefix: 'e2e-mod-ban' });

    const res = await request.post(`${BASE}/v1/sanctions`, {
      headers: apiAuth(policer),
      data: {
        accountId: offender.id,
        severity: 'grave',
        reason: 'E2E test: grave violation',
      },
    });

    expect(res.status()).toBe(201);
    const json = await res.json();
    const sanction = json.data || json;
    expect(sanction.type).toBe('ban');

    await waitFF(500);

    const status = getAccountStatus(offender.id);
    expect(status).toBe('banned');
  });

  test.describe.serial('Ban → vote nullification', () => {
    let voter, chunkOwner, chunk1Id, chunk2Id;

    test.beforeAll(async () => {
      voter = createUserInDB({ prefix: 'e2e-mod-voter', createdAt: "now() - interval '30 days'" });
      chunkOwner = createUserInDB({ prefix: 'e2e-mod-chown' });
      chunk1Id = createChunkInDB(topic.id, chunkOwner.id, `Nullify test chunk 1 ${unique()}`);
      chunk2Id = createChunkInDB(topic.id, chunkOwner.id, `Nullify test chunk 2 ${unique()}`);
    });

    test('ban nullifies all voter votes (weight=0) and recalculates chunks', async ({ request }) => {
      // Cast votes
      await request.post(`${BASE}/v1/votes`, {
        headers: apiAuth(voter),
        data: { target_type: 'chunk', target_id: chunk1Id, value: 'up', reason_tag: 'accurate' },
      });
      await request.post(`${BASE}/v1/votes`, {
        headers: apiAuth(voter),
        data: { target_type: 'chunk', target_id: chunk2Id, value: 'down', reason_tag: 'inaccurate' },
      });
      await waitFF(1000);

      const trustBefore1 = getChunkTrust(chunk1Id);
      const trustBefore2 = getChunkTrust(chunk2Id);

      // Ban the voter
      const res = await request.post(`${BASE}/v1/sanctions`, {
        headers: apiAuth(policer),
        data: {
          accountId: voter.id,
          severity: 'grave',
          reason: 'E2E test: ban for nullification test',
        },
      });
      if (res.status() !== 201) {
        const errBody = await res.json();
        console.error('Ban failed:', res.status(), JSON.stringify(errBody));
      }
      expect(res.status()).toBe(201);

      await waitFF(3000);

      // All votes should have weight = 0
      const weights = getVoteWeights(voter.id);
      for (const v of weights) {
        expect(v.weight).toBe(0);
      }

      // Chunk trust scores should have changed (recalculated without the nullified votes)
      const trustAfter1 = getChunkTrust(chunk1Id);
      const trustAfter2 = getChunkTrust(chunk2Id);
      expect(trustAfter1).not.toBe(trustBefore1);
      expect(trustAfter2).not.toBe(trustBefore2);
    });
  });

  test.describe.serial('Cascade ban', () => {
    test('ban sub-account with grave → parent also banned, votes nullified', async ({ request }) => {
      const parent = createUserInDB({ prefix: 'e2e-mod-parent', createdAt: "now() - interval '30 days'" });
      const { createSubAccountInDB } = require('./helpers');
      const sub = createSubAccountInDB(parent.id);

      // Cast votes from both
      const cascadeOwner = createUserInDB({ prefix: 'e2e-mod-cascown' });
      const chunkId = createChunkInDB(topic.id, cascadeOwner.id, `Cascade test chunk ${unique()}`);
      await request.post(`${BASE}/v1/votes`, {
        headers: apiAuth(parent),
        data: { target_type: 'chunk', target_id: chunkId, value: 'up', reason_tag: 'accurate' },
      });
      await request.post(`${BASE}/v1/votes`, {
        headers: apiAuth(sub),
        data: { target_type: 'chunk', target_id: chunkId, value: 'up', reason_tag: 'relevant' },
      });
      await waitFF(1000);

      // Ban sub-account with grave → triggers cascade
      const res = await request.post(`${BASE}/v1/sanctions`, {
        headers: apiAuth(policer),
        data: {
          accountId: sub.id,
          severity: 'grave',
          reason: 'E2E test: cascade ban trigger',
        },
      });
      expect(res.status()).toBe(201);

      await waitFF(4000);

      // Both should be banned
      expect(getAccountStatus(sub.id)).toBe('banned');
      expect(getAccountStatus(parent.id)).toBe('banned');

      // Both should have votes nullified
      const subWeights = getVoteWeights(sub.id);
      const parentWeights = getVoteWeights(parent.id);
      for (const v of [...subWeights, ...parentWeights]) {
        expect(v.weight).toBe(0);
      }
    });
  });
});
