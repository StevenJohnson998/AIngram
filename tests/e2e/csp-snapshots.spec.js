// @ts-check
/**
 * Visual regression baseline for the CSP hardening migration (S6).
 *
 * Captures a screenshot of every public page (and a few authenticated ones)
 * before the migration. After the migration, re-running this spec compares
 * pixel-by-pixel against the baseline and flags any regressions.
 *
 * Usage:
 *   npx playwright test tests/e2e/csp-snapshots.spec.js                  # compare
 *   npx playwright test tests/e2e/csp-snapshots.spec.js --update-snapshots  # generate baseline
 *
 * Pages with dynamic data (counters, dates) use page.evaluate to neutralize
 * the moving parts before the screenshot.
 */

const { test, expect } = require('@playwright/test');

const BASE = process.env.BASE_URL || 'http://172.18.0.19:3000';

// Anonymous (no auth) pages
const ANONYMOUS_PAGES = [
  { name: 'index', path: '/' },
  { name: 'about', path: '/about.html' },
  { name: 'help', path: '/help.html' },
  { name: 'legal', path: '/legal.html' },
  { name: 'terms', path: '/terms.html' },
  { name: 'login', path: '/login.html' },
  { name: 'register', path: '/register.html' },
  { name: 'hot-topics', path: '/hot-topics.html' },
  { name: 'debates', path: '/debates.html' },
  { name: 'search-empty', path: '/search.html' },
  { name: '404', path: '/this-does-not-exist.html' },
  { name: 'reset-password', path: '/reset-password.html' },
];

// Pages that need a deterministic state (mask out moving parts)
function neutralizeDynamicContent(page) {
  return page.addStyleTag({
    content: `
      /* Hide elements that change between runs */
      #hot-topics, #footer-stats, .timestamp, .relative-time,
      [data-test-dynamic], .activity-feed,
      #recent-activity, #contributors-count {
        visibility: hidden !important;
      }
      /* Disable animations */
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
    `,
  });
}

test.describe('CSP migration -- visual baseline', () => {
  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(15000);
  });

  for (const { name, path } of ANONYMOUS_PAGES) {
    test(`anonymous: ${name}`, async ({ page }) => {
      const response = await page.goto(BASE + path);
      // Allow 404 for the explicit 404 test
      if (name !== '404') {
        expect(response.status(), `${name} should not 5xx`).toBeLessThan(500);
      }
      await page.waitForLoadState('networkidle');
      await neutralizeDynamicContent(page);
      // Small wait for any post-load JS to settle
      await page.waitForTimeout(500);
      await expect(page).toHaveScreenshot(`${name}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.005, // tolerate 0.5% pixel difference (font rendering, antialiasing)
      });
    });
  }
});
