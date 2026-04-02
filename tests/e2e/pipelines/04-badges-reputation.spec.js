// @ts-check
/**
 * 04 — Vote → Badges & Reputation
 *
 * Verifies: upvotes grant badge_contribution, downvotes revoke it,
 * reputation_contribution reflects votes received.
 */

const { test, expect } = require('@playwright/test');
const {
  BASE, apiAuth, createUserInDB, createTopicInDB, createMessageInDB,
  getAccountBadges, waitFF, unique, queryDB,
} = require('./helpers');

test.describe.serial('Vote → Badges & Reputation', () => {
  let badgeAuthor, voter1, voter2;
  let topics = [];
  let messageIds = [];

  test.beforeAll(async () => {
    // Author must be >30 days old for badge eligibility
    badgeAuthor = createUserInDB({
      prefix: 'e2e-badge-auth',
      createdAt: "now() - interval '60 days'",
    });
    voter1 = createUserInDB({
      prefix: 'e2e-badge-v1',
      createdAt: "now() - interval '30 days'",
    });
    voter2 = createUserInDB({
      prefix: 'e2e-badge-v2',
      createdAt: "now() - interval '30 days'",
    });

    // Create 3 topics with 2 level-1 messages each (6 total, 3+ distinct topics)
    for (let i = 0; i < 3; i++) {
      const t = createTopicInDB(badgeAuthor.id);
      topics.push(t);
      for (let j = 0; j < 2; j++) {
        const msgId = createMessageInDB(t.id, badgeAuthor.id, {
          level: 1,
          type: 'contribution',
          content: `Badge test message ${i}-${j} ${unique()}`,
        });
        messageIds.push(msgId);
      }
    }
  });

  test('badge_contribution is false before votes', async () => {
    const badges = getAccountBadges(badgeAuthor.id);
    expect(badges.contribution).toBe(false);
  });

  test('6 upvotes across 3 topics grant badge_contribution', async ({ request }) => {
    // Cast upvotes on all 6 messages from voter1
    // Beta prior: alpha=1, beta=1. With 6 upvotes (weight ~1.0 each): alpha=7, ratio=7/8=0.875 > 0.85
    for (const msgId of messageIds) {
      const res = await request.post(`${BASE}/v1/votes`, {
        headers: apiAuth(voter1),
        data: {
          target_type: 'message',
          target_id: msgId,
          value: 'up',
          reason_tag: 'accurate',
        },
      });
      expect(res.status()).toBe(201);
    }

    await waitFF(3000);

    const badges = getAccountBadges(badgeAuthor.id);
    expect(badges.contribution).toBe(true);
  });

  test('downvotes drop ratio below threshold → badge revoked', async ({ request }) => {
    // Cast 4 downvotes from voter2 to drop ratio
    // After: alpha=1+6=7 up, beta=1+4=5 down, ratio=7/12=0.583 < 0.85
    for (let i = 0; i < 4; i++) {
      const res = await request.post(`${BASE}/v1/votes`, {
        headers: apiAuth(voter2),
        data: {
          target_type: 'message',
          target_id: messageIds[i],
          value: 'down',
          reason_tag: 'inaccurate',
        },
      });
      expect(res.status()).toBe(201);
    }

    await waitFF(2000);

    const badges = getAccountBadges(badgeAuthor.id);
    expect(badges.contribution).toBe(false);
  });

  test('reputation_contribution reflects vote aggregate', async () => {
    const rep = queryDB(`SELECT reputation_contribution FROM accounts WHERE id = '${badgeAuthor.id}'`);
    const repValue = parseFloat(rep);
    // With 6 up (weight~1) and 4 down (weight~1): alpha=1+6=7, beta=1+4=5, rep=7/12≈0.583
    // Should not be the default 0.5
    expect(repValue).not.toBe(0.5);
    expect(repValue).toBeGreaterThan(0);
    expect(repValue).toBeLessThan(1);
  });
});
