/**
 * One-shot tool: extract inline <script> blocks from each HTML page in
 * src/gui/*.html into external .js files in src/gui/js/, and replace the
 * inline block with <script src="./js/<page>.js"></script>.
 *
 * Each HTML page has exactly one inline script block (verified). The script
 * usually runs after DOMContentLoaded because it's at the bottom of <body>.
 *
 * Usage:
 *   node scripts/csp-extract-inline-scripts.js
 *
 * Idempotent: skips files where the inline block has already been extracted.
 */

const fs = require('fs');
const path = require('path');

const GUI_DIR = path.join(__dirname, '..', 'src', 'gui');
const JS_DIR = path.join(GUI_DIR, 'js');

// Match a <script> with NO src attribute (or any other attributes), capturing its content
// Non-greedy on the body so we don't span past the closing tag.
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/;

fs.mkdirSync(JS_DIR, { recursive: true });

const files = fs
  .readdirSync(GUI_DIR)
  .filter(f => f.endsWith('.html'))
  .filter(f => f !== 'js'); // exclude the new dir

let extracted = 0;
let skipped = 0;
let unchanged = 0;

for (const file of files) {
  const fullPath = path.join(GUI_DIR, file);
  const html = fs.readFileSync(fullPath, 'utf8');
  const baseName = file.replace(/\.html$/, '');

  const match = html.match(INLINE_SCRIPT_RE);
  if (!match) {
    unchanged++;
    continue;
  }

  const inlineContent = match[1];
  const jsFileName = `${baseName}.js`;
  const jsPath = path.join(JS_DIR, jsFileName);

  if (fs.existsSync(jsPath)) {
    console.log(`SKIP ${file}: ${jsFileName} already exists`);
    skipped++;
    continue;
  }

  // Write external JS file
  const header = `/* Extracted from src/gui/${file} during CSP S6 migration. */\n`;
  fs.writeFileSync(jsPath, header + inlineContent.trim() + '\n');

  // Replace the inline block in HTML with a <script src="..."> reference
  const newHtml = html.replace(
    INLINE_SCRIPT_RE,
    `<script src="./js/${jsFileName}"></script>`
  );
  fs.writeFileSync(fullPath, newHtml);

  console.log(`OK   ${file} -> js/${jsFileName} (${inlineContent.length} bytes)`);
  extracted++;
}

console.log(`\nSummary: extracted=${extracted} skipped=${skipped} unchanged=${unchanged}`);
