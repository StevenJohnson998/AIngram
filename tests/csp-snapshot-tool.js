/**
 * CSP migration visual snapshot tool.
 *
 * Captures screenshots of every public page (and a few authenticated states)
 * for visual regression detection during the S6 CSP hardening.
 *
 * Usage (inside aingram-api-test container):
 *   node tests/csp-snapshot-tool.js baseline   # capture before migration
 *   node tests/csp-snapshot-tool.js after      # capture after migration
 *   node tests/csp-snapshot-tool.js diff       # compare baseline vs after
 *
 * Bypasses Playwright Test runner because Playwright 1.58's headless_shell
 * binary requires glibc and the container is Alpine. Uses the Playwright
 * library directly with the system chromium (apk add chromium).
 */

const { chromium } = require('/app/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const SNAPSHOT_DIR = path.join(__dirname, 'snapshots');
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

// Pages reachable without auth
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
  { name: '404', path: '/this-does-not-exist.html', expect404: true },
  { name: 'reset-password', path: '/reset-password.html' },
];

// Selectors for dynamic elements we want hidden in screenshots.
// We can't use page.addStyleTag() because the strict CSP (after migration) blocks
// inline <style> injection. Instead we set element.style.visibility = 'hidden'
// per element via page.evaluate, which is allowed by CSP (style-src controls
// stylesheets and style attributes, not the JS .style API in modern browsers).
const NEUTRALIZE_SELECTORS = [
  '#hot-topics',
  '#footer-stats',
  '#recent-activity',
  '#contributors-count',
  '.timestamp',
  '.relative-time',
  '.activity-feed',
  '[data-test-dynamic]',
  '#admin-health-banner',
];

async function neutralizeDynamicContent(page) {
  await page.evaluate((selectors) => {
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        el.style.visibility = 'hidden';
      });
    }
  }, NEUTRALIZE_SELECTORS);
}

async function captureMode(mode) {
  const outDir = path.join(SNAPSHOT_DIR, mode);
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  let success = 0;
  let fail = 0;

  for (const p of ANONYMOUS_PAGES) {
    try {
      const response = await page.goto(BASE + p.path, {
        timeout: 15000,
        waitUntil: 'domcontentloaded',
      });
      if (!p.expect404 && response.status() >= 500) {
        throw new Error(`HTTP ${response.status()}`);
      }
      // Wait for client-side init (api.js, updateNavbar, etc.)
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await neutralizeDynamicContent(page);
      await page.waitForTimeout(400);
      const filePath = path.join(outDir, `${p.name}.png`);
      await page.screenshot({ path: filePath, fullPage: true });
      console.log(`  OK ${p.name}`);
      success++;
    } catch (e) {
      console.error(`  FAIL ${p.name}: ${e.message}`);
      fail++;
    }
  }

  await browser.close();
  console.log(`\n${mode}: ${success} captured, ${fail} failed`);
  return { success, fail };
}

function diffMode() {
  const baselineDir = path.join(SNAPSHOT_DIR, 'baseline');
  const afterDir = path.join(SNAPSHOT_DIR, 'after');
  const diffDir = path.join(SNAPSHOT_DIR, 'diff');
  fs.mkdirSync(diffDir, { recursive: true });

  if (!fs.existsSync(baselineDir)) {
    console.error(`No baseline found at ${baselineDir}. Run "baseline" first.`);
    process.exit(1);
  }
  if (!fs.existsSync(afterDir)) {
    console.error(`No after found at ${afterDir}. Run "after" first.`);
    process.exit(1);
  }

  // Use ImageMagick `compare` for pixel diff (returns AE = number of differing pixels)
  const baselineFiles = fs.readdirSync(baselineDir).filter(f => f.endsWith('.png'));
  const results = [];
  for (const f of baselineFiles) {
    const baseFile = path.join(baselineDir, f);
    const afterFile = path.join(afterDir, f);
    const diffFile = path.join(diffDir, f);
    if (!fs.existsSync(afterFile)) {
      results.push({ name: f, status: 'MISSING_AFTER', pixels: null });
      continue;
    }
    try {
      // Returns differing pixel count on stdout
      const out = execSync(
        `compare -metric AE -fuzz 1% "${baseFile}" "${afterFile}" "${diffFile}" 2>&1 || true`,
        { encoding: 'utf8' }
      ).trim();
      const pixels = parseInt(out, 10);
      results.push({
        name: f,
        status: pixels === 0 ? 'IDENTICAL' : pixels < 50 ? 'MINOR' : 'CHANGED',
        pixels: isNaN(pixels) ? out : pixels,
      });
    } catch (e) {
      results.push({ name: f, status: 'COMPARE_ERROR', pixels: e.message });
    }
  }

  // Print summary
  console.log('\n=== Visual diff summary ===');
  const counts = { IDENTICAL: 0, MINOR: 0, CHANGED: 0, MISSING_AFTER: 0, COMPARE_ERROR: 0 };
  for (const r of results) {
    counts[r.status]++;
    const icon = r.status === 'IDENTICAL' ? 'OK' : r.status === 'MINOR' ? '~' : 'X';
    console.log(`  ${icon} ${r.name.padEnd(28)} ${r.status} (${r.pixels} px)`);
  }
  console.log('\nCounts:', counts);
  console.log(`Diff images saved to: ${diffDir}`);

  // Exit code: 0 if all identical/minor, 1 if any changed
  process.exit(counts.CHANGED + counts.MISSING_AFTER + counts.COMPARE_ERROR > 0 ? 1 : 0);
}

const mode = process.argv[2] || 'baseline';
if (mode === 'baseline' || mode === 'after') {
  captureMode(mode).then(({ fail }) => process.exit(fail > 0 ? 1 : 0));
} else if (mode === 'diff') {
  diffMode();
} else {
  console.error(`Unknown mode: ${mode}. Use baseline | after | diff`);
  process.exit(1);
}
