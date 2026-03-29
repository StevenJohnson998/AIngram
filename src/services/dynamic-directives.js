/**
 * Dynamic directives service — generates enriched reviewer guidelines from analytics.
 * Sprint 7b: Writes to /tmp/aingram-directives/ to avoid Docker bind mount issues.
 */

const fs = require('fs');
const path = require('path');
const analyticsService = require('./copyright-analytics');

const OUTPUT_DIR = '/tmp/aingram-directives';
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'llms-copyright-dynamic.txt');
const TEMPLATE_FILE = path.join(__dirname, '../gui/llms-copyright.txt');

/**
 * Generate enriched copyright directive with live analytics baked in.
 * Reads the static template and appends a "Current Statistics" section.
 */
async function generateCopyrightDirective() {
  try {
    const template = fs.readFileSync(TEMPLATE_FILE, 'utf-8');
    const analytics = await analyticsService.getOverview();

    const statsSection = buildStatsSection(analytics);

    const output = template + '\n\n' + statsSection;

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    fs.writeFileSync(OUTPUT_FILE, output, 'utf-8');
    console.log('Dynamic copyright directive generated');
  } catch (err) {
    console.error('Dynamic directive generation failed:', err.message);
  }
}

/**
 * Build the analytics section to append to the template.
 */
function buildStatsSection(analytics) {
  if (!analytics || analytics.total_reviews === 0) {
    return [
      '## Current Statistics (auto-generated)',
      '',
      'No copyright reviews resolved yet. Statistics will appear after the first review.',
      '',
      '_Last updated: ' + new Date().toISOString() + '_',
    ].join('\n');
  }

  const lines = [
    '## Current Statistics (auto-generated)',
    '',
    'These statistics are computed from resolved copyright reviews and updated every 24 hours.',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    '| Total resolved reviews | ' + analytics.total_reviews + ' |',
    '| Clear (unfounded) | ' + analytics.clear_count + ' (' + pct(analytics.clear_count, analytics.total_reviews) + ') |',
    '| Rewrite required | ' + analytics.rewrite_count + ' (' + pct(analytics.rewrite_count, analytics.total_reviews) + ') |',
    '| Takedown | ' + analytics.takedown_count + ' (' + pct(analytics.takedown_count, analytics.total_reviews) + ') |',
    '| System false positive rate | ' + ((analytics.system_fp_rate * 100).toFixed(1)) + '% |',
    '| Avg resolution time | ' + (analytics.avg_resolution_hours || 'N/A') + ' hours |',
    '| Median resolution time | ' + (analytics.median_resolution_hours || 'N/A') + ' hours |',
    '| High-priority reviews | ' + analytics.high_priority_count + ' |',
    '',
  ];

  // Reviewer hints based on data
  if (analytics.system_fp_rate > 0.5) {
    lines.push('**Note:** Over half of reports are found unfounded. Prioritize Step 1 (verbatim check) before deep-diving into licensing analysis.');
    lines.push('');
  }
  if (analytics.system_fp_rate < 0.2 && analytics.total_reviews >= 10) {
    lines.push('**Note:** Low false positive rate indicates reporters are generally submitting valid claims. Proceed carefully through all 4 steps.');
    lines.push('');
  }

  lines.push('_Last updated: ' + new Date().toISOString() + '_');

  return lines.join('\n');
}

function pct(count, total) {
  if (total === 0) return '0%';
  return ((count / total) * 100).toFixed(0) + '%';
}

/**
 * Get the path to the dynamic directive file (for serving via route).
 */
function getDynamicDirectivePath() {
  return OUTPUT_FILE;
}

module.exports = {
  generateCopyrightDirective,
  getDynamicDirectivePath,
  buildStatsSection,
};
