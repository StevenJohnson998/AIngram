// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = process.env.BASE_URL || 'http://172.18.0.20:3000';

test.describe('D1: Subscribe button', () => {
  test('topic.html has Subscribe button (not Watch)', async ({ page }) => {
    const response = await page.request.get(BASE + '/topics?limit=1');
    const data = await response.json();
    const topicId = data?.data?.[0]?.id;
    if (!topicId) { test.skip(); return; }

    await page.goto(BASE + '/topic.html?id=' + topicId);
    await page.waitForSelector('#topic-content', { state: 'visible', timeout: 10000 });

    // Button should exist in DOM (may be hidden if not auth)
    const btn = page.locator('#watch-btn');
    await expect(btn).toBeAttached();
    // Text should be "Subscribe" not "Watch"
    const text = await btn.textContent();
    expect(text).not.toContain('Watch');
    expect(['Subscribe', 'Subscribed']).toContain(text.trim());
  });
});

test.describe('D1: Homepage subscriptions section', () => {
  test('index.html has subscriptions section in DOM', async ({ page }) => {
    await page.goto(BASE + '/index.html');
    await expect(page.locator('#subscriptions-section')).toBeAttached();
  });
});

test.describe('D2: Tier level in reputation API', () => {
  test('reputation endpoint returns tier and tierName', async ({ page }) => {
    // Use API directly - find an account
    const topicsRes = await page.request.get(BASE + '/topics?limit=1');
    const topics = await topicsRes.json();
    const createdBy = topics?.data?.[0]?.created_by;
    if (!createdBy) { test.skip(); return; }

    const repRes = await page.request.get(BASE + '/accounts/' + createdBy + '/reputation');
    expect(repRes.status()).toBe(200);
    const repJson = await repRes.json();
    const rep = repJson.data || repJson;
    expect(rep).toHaveProperty('tier');
    expect(rep).toHaveProperty('tierName');
    expect(['Newcomer', 'Contributor', 'Trusted']).toContain(rep.tierName);
  });
});

test.describe('E1: Request-a-topic', () => {
  test('search.html has request-topic-box in DOM', async ({ page }) => {
    await page.goto(BASE + '/search.html');
    await expect(page.locator('#request-topic-box')).toBeAttached();
  });

  test('request-topic API validates input', async ({ page }) => {
    // Short title should 400
    const res = await page.request.post(BASE + '/topic-requests', {
      data: { title: 'ab' },
      headers: { 'Content-Type': 'application/json' },
    });
    // 400 or 401 (no auth)
    expect([400, 401]).toContain(res.status());
  });
});

test.describe('E3: Vote feedback (no alert)', () => {
  test('topic.html does not use alert() for vote feedback', async ({ page }) => {
    const response = await page.request.get(BASE + '/topics?limit=1');
    const data = await response.json();
    const topicId = data?.data?.[0]?.id;
    if (!topicId) { test.skip(); return; }

    await page.goto(BASE + '/topic.html?id=' + topicId);
    await page.waitForSelector('#topic-content', { state: 'visible', timeout: 10000 });

    // Check that the page JS uses showAlert instead of alert for vote functions
    const hasAlertInVote = await page.evaluate(() => {
      var scripts = document.querySelectorAll('script');
      for (var s of scripts) {
        var text = s.textContent || '';
        // Look for alert() specifically in vote/commit/reveal contexts
        if (text.includes('function voteChunk') && /\balert\(/.test(text.match(/function voteChunk[\s\S]*?function /)?.[0] || '')) {
          return true;
        }
      }
      return false;
    });
    expect(hasAlertInVote).toBe(false);
  });
});
