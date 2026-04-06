// @ts-check
const { test, expect } = require('@playwright/test');

// Use shared network IP for container access
const BASE = process.env.BASE_URL || 'http://172.18.0.20:3000';

test.describe('Metachunk GUI features', () => {

  test('index.html shows topic type filter buttons', async ({ page }) => {
    await page.goto(BASE + '/index.html');
    await expect(page.locator('button.topic-type-btn[data-type=""]')).toBeVisible();
    await expect(page.locator('button.topic-type-btn[data-type="knowledge"]')).toBeVisible();
    await expect(page.locator('button.topic-type-btn[data-type="course"]')).toBeVisible();
  });

  test('index.html course filter changes heading and loads', async ({ page }) => {
    await page.goto(BASE + '/index.html');
    await page.waitForFunction(() => typeof window.filterByType === 'function');
    // Use evaluate to trigger onclick (Playwright click doesn't always fire inline onclick in headless)
    await page.evaluate(() => {
      var btn = document.querySelector('button.topic-type-btn[data-type="course"]');
      filterByType(btn);
    });
    await expect(page.locator('#topics-heading')).toHaveText('Courses', { timeout: 10000 });
    await page.waitForTimeout(1000);
    const container = page.locator('#hot-topics');
    const html = await container.innerHTML();
    expect(html).not.toContain('skeleton-card');
  });

  test('index.html Articles filter works', async ({ page }) => {
    await page.goto(BASE + '/index.html');
    await page.waitForFunction(() => typeof window.filterByType === 'function');
    await page.evaluate(() => {
      var btn = document.querySelector('button.topic-type-btn[data-type="knowledge"]');
      filterByType(btn);
    });
    await expect(page.locator('#topics-heading')).toHaveText('Articles', { timeout: 10000 });
  });

  test('search.html has Content filter dropdown', async ({ page }) => {
    await page.goto(BASE + '/search.html');
    await expect(page.locator('#filter-topic-type')).toBeVisible();
    const options = await page.locator('#filter-topic-type option').allTextContents();
    expect(options).toContain('All');
    expect(options).toContain('Articles');
    expect(options).toContain('Courses');
  });

  test('topic.html loads without errors', async ({ page }) => {
    // Load a topic that exists (use the first from the API)
    const response = await page.request.get(BASE + '/topics?limit=1');
    const data = await response.json();
    const topicId = data?.data?.[0]?.id;
    if (!topicId) {
      test.skip();
      return;
    }

    // Collect console errors
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

    await page.goto(BASE + '/topic.html?id=' + topicId);
    await page.waitForSelector('#topic-content', { state: 'visible', timeout: 10000 });

    // Topic should render
    await expect(page.locator('#topic-title')).not.toBeEmpty();

    // No JS errors related to our changes
    const metachunkErrors = errors.filter(e => e.includes('metachunk') || e.includes('applyMetachunkOrder') || e.includes('buildToc'));
    expect(metachunkErrors).toEqual([]);
  });

  test('topic.html TOC and bibliography sections exist in DOM', async ({ page }) => {
    const response = await page.request.get(BASE + '/topics?limit=1');
    const data = await response.json();
    const topicId = data?.data?.[0]?.id;
    if (!topicId) { test.skip(); return; }

    await page.goto(BASE + '/topic.html?id=' + topicId);
    await page.waitForSelector('#topic-content', { state: 'visible', timeout: 10000 });

    // TOC and bibliography sections should exist in DOM (may be hidden)
    await expect(page.locator('#toc-section')).toBeAttached();
    await expect(page.locator('#bibliography-section')).toBeAttached();
  });

  test('topic.html course header exists in DOM', async ({ page }) => {
    const response = await page.request.get(BASE + '/topics?limit=1');
    const data = await response.json();
    const topicId = data?.data?.[0]?.id;
    if (!topicId) { test.skip(); return; }

    await page.goto(BASE + '/topic.html?id=' + topicId);
    await page.waitForSelector('#topic-content', { state: 'visible', timeout: 10000 });

    // Course header exists (hidden for non-course topics)
    await expect(page.locator('#course-header')).toBeAttached();
  });
});
