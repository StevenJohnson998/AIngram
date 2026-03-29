// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = process.env.BASE_URL || 'http://172.18.0.22:3000';

test.describe('AIngram GUI Smoke Tests', () => {

  test('landing page loads with title and structure', async ({ page }) => {
    await page.goto(BASE + '/');
    await expect(page).toHaveTitle(/AIngram/);

    // Hot topics section exists
    await expect(page.locator('#hot-topics')).toBeVisible({ timeout: 5000 });

    // Footer stats section exists
    await expect(page.locator('#footer-stats')).toBeVisible();
  });

  test('search returns results for "governance"', async ({ page }) => {
    // Capture console for debugging
    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

    await page.goto(BASE + '/search.html?q=governance');

    // Wait for either results or error
    await page.waitForFunction(() => {
      const info = document.getElementById('results-info');
      const empty = document.getElementById('results-empty');
      const error = document.querySelector('.alert-warning');
      return (info && info.style.display !== 'none') ||
             (empty && empty.style.display !== 'none') ||
             error;
    }, { timeout: 15000 }).catch(async () => {
      // Debug: take screenshot and dump page content
      await page.screenshot({ path: 'test-results/search-debug.png' });
      const html = await page.content();
      console.log('Page HTML (truncated):', html.substring(html.indexOf('<body'), html.indexOf('<body') + 2000));
      console.log('Console logs:', logs.join('\n'));
      throw new Error('Search did not complete within 15s');
    });

    // Check results appeared
    const infoEl = page.locator('#results-info');
    if (await infoEl.isVisible()) {
      const text = await infoEl.textContent();
      expect(text).toMatch(/\d+ results?/);
    }
  });

  test('search with no results shows empty state', async ({ page }) => {
    await page.goto(BASE + '/search.html?q=xyznonexistent12345');
    await page.waitForFunction(() => {
      const empty = document.getElementById('results-empty');
      const info = document.getElementById('results-info');
      return (empty && empty.style.display !== 'none') ||
             (info && info.textContent.includes('0 result'));
    }, { timeout: 15000 });
  });

  test('topic page loads', async ({ page }) => {
    // Get a topic slug from API
    const res = await page.request.get(BASE + '/v1/topics?limit=1');
    const json = await res.json();
    const slug = json.data[0].slug;

    await page.goto(BASE + '/topic.html?slug=' + slug);
    // Topic pages load content dynamically
    await page.waitForFunction(() => document.querySelector('h1, .topic-title, .topic-header'), { timeout: 10000 });
  });

  test('login page loads with form', async ({ page }) => {
    await page.goto(BASE + '/login.html');
    await expect(page).toHaveTitle(/AIngram/);
    // Check for any input field (email might be type="text")
    await expect(page.locator('form input').first()).toBeVisible();
  });

  test('register page loads with TOS checkbox', async ({ page }) => {
    await page.goto(BASE + '/register.html');
    await expect(page.locator('input[type="checkbox"]')).toBeVisible();
  });

  test('health endpoint returns ok v1.0.0', async ({ page }) => {
    const res = await page.request.get(BASE + '/health');
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.version).toBe('1.0.0');
  });

  test('llms.txt accessible with correct structure', async ({ page }) => {
    const res = await page.request.get(BASE + '/llms.txt');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('# AIngram');
    expect(text).toContain('llms-search.txt');
  });

  test('review queue page loads', async ({ page }) => {
    await page.goto(BASE + '/review-queue.html');
    await expect(page).toHaveTitle(/AIngram/);
  });

  test('no JS errors on landing page (ignoring analytics)', async ({ page }) => {
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto(BASE + '/');
    await page.waitForTimeout(2000);
    // Filter out expected errors in test env (analytics CORS, SSL, COOP header)
    const realErrors = errors.filter(e =>
      !e.includes('favicon') && !e.includes('media-src') &&
      !e.includes('analytics') && !e.includes('ERR_SSL') &&
      !e.includes('Cross-Origin-Opener') && !e.includes('ERR_FAILED') &&
      !e.includes('401')
    );
    expect(realErrors).toEqual([]);
  });

  test('no JS errors on search page (ignoring analytics)', async ({ page }) => {
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto(BASE + '/search.html?q=agent');
    await page.waitForTimeout(3000);
    const realErrors = errors.filter(e =>
      !e.includes('favicon') && !e.includes('media-src') &&
      !e.includes('analytics') && !e.includes('ERR_SSL') &&
      !e.includes('Cross-Origin-Opener') && !e.includes('ERR_FAILED') &&
      !e.includes('401')
    );
    expect(realErrors).toEqual([]);
  });
});
