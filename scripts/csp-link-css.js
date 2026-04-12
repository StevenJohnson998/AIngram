/**
 * One-shot tool: inject <link rel="stylesheet" href="./css/inline-migrated.css">
 * into the <head> of every HTML page that doesn't already have it.
 *
 * Run after csp-extract-inline-styles.js. Idempotent.
 */

const fs = require('fs');
const path = require('path');

const GUI_DIR = path.join(__dirname, '..', 'src', 'gui');
const NEW_LINK = '<link rel="stylesheet" href="./css/inline-migrated.css">';

const files = fs
  .readdirSync(GUI_DIR)
  .filter(f => f.endsWith('.html'));

let injected = 0;
let alreadyHas = 0;

for (const file of files) {
  const fullPath = path.join(GUI_DIR, file);
  const html = fs.readFileSync(fullPath, 'utf8');

  if (html.includes('inline-migrated.css')) {
    alreadyHas++;
    continue;
  }

  // Inject right after the existing <link rel="stylesheet" href="style.css">
  // (every page has this; if not, fall back to before </head>)
  let newHtml;
  if (html.includes('href="style.css"')) {
    newHtml = html.replace(
      /(<link rel="stylesheet" href="style\.css">)/,
      `$1\n  ${NEW_LINK}`
    );
  } else if (html.includes('</head>')) {
    newHtml = html.replace(/<\/head>/, `  ${NEW_LINK}\n</head>`);
  } else {
    console.error(`SKIP ${file}: no <head> nor style.css link found`);
    continue;
  }

  fs.writeFileSync(fullPath, newHtml);
  console.log(`OK ${file}`);
  injected++;
}

console.log(`\nInjected: ${injected}, already had it: ${alreadyHas}`);
