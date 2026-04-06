// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = process.env.BASE_URL || 'http://172.18.0.20:3000';

test.describe('Debates page', () => {
  test('debates.html loads and shows structure', async ({ page }) => {
    await page.goto(BASE + '/debates.html');
    await expect(page.locator('h1')).toContainText('Debates');
    // Container should exist
    await expect(page.locator('#debates-container')).toBeAttached();
    await expect(page.locator('#featured-section')).toBeAttached();
  });

  test('debates.html shows debate data or empty state', async ({ page }) => {
    await page.goto(BASE + '/debates.html');
    // Wait for JS to load
    await page.waitForTimeout(2000);
    const container = page.locator('#debates-container');
    const html = await container.innerHTML();
    // Should not show skeleton anymore
    expect(html).not.toContain('skeleton-card');
  });

  test('debates API returns valid structure', async ({ page }) => {
    const response = await page.request.get(BASE + '/debates?limit=5');
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('data');
    expect(data).toHaveProperty('featured');
    expect(Array.isArray(data.data)).toBe(true);
  });
});

test.describe('Landing page 3 pillars', () => {
  test('index.html shows 3 pillar cards', async ({ page }) => {
    await page.goto(BASE + '/index.html');
    // Check for 3 pillar card headings
    await expect(page.locator('h3:text-is("Articles")')).toBeVisible();
    await expect(page.locator('h3:text-is("Debates")')).toBeVisible();
    await expect(page.locator('h3:text-is("Courses")')).toBeVisible();
  });

  test('index.html hero says Articles. Debates. Courses.', async ({ page }) => {
    await page.goto(BASE + '/index.html');
    await expect(page.locator('h1')).toContainText('Articles. Debates. Courses.');
  });

  test('index.html has active debates section', async ({ page }) => {
    await page.goto(BASE + '/index.html');
    await expect(page.locator('#active-debates')).toBeAttached();
    // Wait for data
    await page.waitForTimeout(2000);
    const html = await page.locator('#active-debates').innerHTML();
    expect(html).not.toContain('skeleton-card');
  });
});

test.describe('Navbar updated', () => {
  test('navbar has Debates link', async ({ page }) => {
    await page.goto(BASE + '/index.html');
    await expect(page.locator('.navbar-nav a[href="./debates.html"]')).toBeVisible();
  });

  test('navbar has + New Article link', async ({ page }) => {
    await page.goto(BASE + '/index.html');
    await expect(page.locator('.navbar-nav a[href="./new-article.html"]')).toBeAttached();
  });

  test('navbar no longer has Review or Suggestions', async ({ page }) => {
    await page.goto(BASE + '/index.html');
    const navHtml = await page.locator('.navbar-nav').innerHTML();
    expect(navHtml).not.toContain('Review');
    expect(navHtml).not.toContain('Suggestions');
  });
});
