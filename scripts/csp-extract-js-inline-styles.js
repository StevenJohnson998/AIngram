/**
 * One-shot tool: replace inline style="..." attributes inside string-concat
 * HTML in src/gui/js/*.js and src/gui/api.js with content-hashed CSS classes,
 * appending the new declarations to src/gui/css/inline-migrated.css.
 *
 * Why a separate script: the HTML script already handles src/gui/*.html. JS
 * files contain <element class="..." style="..."> inside string literals,
 * which need a different replacement strategy (merge into adjacent class=
 * within the same string).
 *
 * Run AFTER scripts/csp-extract-inline-styles.js so the existing CSS file
 * is appended (not overwritten).
 *
 * Idempotent on re-runs: skips s-<hash> classes already in the CSS file.
 *
 * Usage:
 *   node scripts/csp-extract-js-inline-styles.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GUI_DIR = path.join(__dirname, '..', 'src', 'gui');
const JS_DIR = path.join(GUI_DIR, 'js');
const CSS_FILE = path.join(GUI_DIR, 'css', 'inline-migrated.css');

// Load existing CSS classes so we don't duplicate
const existingClasses = new Set();
if (fs.existsSync(CSS_FILE)) {
  const cssContent = fs.readFileSync(CSS_FILE, 'utf8');
  const classRegex = /\.(s-[0-9a-f]{8})\s*\{/g;
  let m;
  while ((m = classRegex.exec(cssContent)) !== null) {
    existingClasses.add(m[1]);
  }
}

const newClasses = new Map(); // className -> declaration body

function normalizeStyle(raw) {
  return raw
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(decl => {
      const colonIdx = decl.indexOf(':');
      if (colonIdx < 0) return decl;
      const prop = decl.slice(0, colonIdx).trim().toLowerCase();
      const val = decl.slice(colonIdx + 1).trim();
      return `${prop}: ${val}`;
    })
    .join('; ');
}

function hashStyle(normalized) {
  return crypto
    .createHash('sha1')
    .update(normalized)
    .digest('hex')
    .slice(0, 8);
}

/**
 * Process a single JS file in place. Looks for two patterns inside string
 * literals:
 *   1. class="X" style="Y"  -> class="X s-hash"
 *   2. style="Y" class="X"  -> class="X s-hash"  (rare but possible)
 *   3. style="Y"            -> class="s-hash"   (when no adjacent class=)
 *
 * The replacement is whitespace-conservative to avoid altering string layout.
 */
function processFile(filePath) {
  let src = fs.readFileSync(filePath, 'utf8');
  const file = path.basename(filePath);
  let count = 0;

  // Pattern 1: class first, then style
  src = src.replace(
    /class="([^"]*)"\s+style="([^"]*)"/g,
    (full, classes, style) => {
      const normalized = normalizeStyle(style);
      if (!normalized) return full;
      const hash = hashStyle(normalized);
      const className = `s-${hash}`;
      if (!existingClasses.has(className) && !newClasses.has(className)) {
        newClasses.set(className, normalized);
      }
      count++;
      return `class="${classes} ${className}"`;
    }
  );

  // Pattern 2: style first, then class
  src = src.replace(
    /style="([^"]*)"\s+class="([^"]*)"/g,
    (full, style, classes) => {
      const normalized = normalizeStyle(style);
      if (!normalized) return full;
      const hash = hashStyle(normalized);
      const className = `s-${hash}`;
      if (!existingClasses.has(className) && !newClasses.has(className)) {
        newClasses.set(className, normalized);
      }
      count++;
      return `class="${classes} ${className}"`;
    }
  );

  // Pattern 3: orphan style= (no adjacent class=)
  src = src.replace(
    /style="([^"]*)"/g,
    (full, style) => {
      const normalized = normalizeStyle(style);
      if (!normalized) return full;
      const hash = hashStyle(normalized);
      const className = `s-${hash}`;
      if (!existingClasses.has(className) && !newClasses.has(className)) {
        newClasses.set(className, normalized);
      }
      count++;
      return `class="${className}"`;
    }
  );

  if (count > 0) {
    fs.writeFileSync(filePath, src);
    console.log(`OK ${file}: ${count} inline styles -> classes`);
  }
  return count;
}

// Files to process
const targets = [
  path.join(GUI_DIR, 'api.js'),
  ...fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js')).map(f => path.join(JS_DIR, f)),
];

let total = 0;
for (const t of targets) {
  if (!fs.existsSync(t)) continue;
  total += processFile(t);
}

// Append new classes to the CSS file
if (newClasses.size > 0) {
  const cssLines = [
    '',
    '/* Appended by scripts/csp-extract-js-inline-styles.js for inline styles found in JS template strings. */',
    '',
  ];
  for (const [className, decl] of [...newClasses.entries()].sort()) {
    cssLines.push(`.${className} { ${decl}; }`);
  }
  fs.appendFileSync(CSS_FILE, cssLines.join('\n') + '\n');
}

console.log(`\nTotal: ${total} inline styles replaced in JS files`);
console.log(`New classes added to CSS: ${newClasses.size}`);
console.log(`Existing classes in CSS: ${existingClasses.size}`);
