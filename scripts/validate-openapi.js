#!/usr/bin/env node

/**
 * Validate the OpenAPI 3.1 spec against the schema.
 * Usage: node scripts/validate-openapi.js
 */

const fs = require('fs');
const path = require('path');

const specPath = path.join(__dirname, '..', 'src', 'gui', 'openapi.json');

try {
  const raw = fs.readFileSync(specPath, 'utf-8');
  const spec = JSON.parse(raw);

  // Basic structural checks
  const errors = [];

  if (!spec.openapi || !spec.openapi.startsWith('3.1')) {
    errors.push('Missing or invalid openapi version (expected 3.1.x)');
  }

  if (!spec.info || !spec.info.title || !spec.info.version) {
    errors.push('Missing info.title or info.version');
  }

  if (!spec.paths || Object.keys(spec.paths).length === 0) {
    errors.push('No paths defined');
  }

  // Check all paths have at least one method
  for (const [pathKey, pathItem] of Object.entries(spec.paths || {})) {
    const methods = ['get', 'post', 'put', 'patch', 'delete'].filter(m => pathItem[m]);
    if (methods.length === 0) {
      errors.push(`Path ${pathKey} has no methods defined`);
    }
    for (const method of methods) {
      const op = pathItem[method];
      if (!op.responses || Object.keys(op.responses).length === 0) {
        errors.push(`${method.toUpperCase()} ${pathKey} has no responses`);
      }
      if (!op.operationId) {
        errors.push(`${method.toUpperCase()} ${pathKey} has no operationId`);
      }
    }
  }

  // Check $ref targets exist
  const specStr = JSON.stringify(spec);
  const refMatches = specStr.match(/"#\/components\/schemas\/\w+"/g) || [];
  const schemaNames = Object.keys(spec.components?.schemas || {});
  for (const ref of refMatches) {
    const name = ref.replace(/.*\//, '').replace('"', '');
    if (!schemaNames.includes(name)) {
      errors.push(`Unresolved $ref: #/components/schemas/${name}`);
    }
  }

  const pathCount = Object.keys(spec.paths).length;
  const opCount = Object.values(spec.paths).reduce(
    (sum, p) => sum + ['get', 'post', 'put', 'patch', 'delete'].filter(m => p[m]).length,
    0
  );

  if (errors.length > 0) {
    console.error('OpenAPI validation FAILED:');
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }

  console.log(`OpenAPI spec valid: ${pathCount} paths, ${opCount} operations, ${schemaNames.length} schemas`);
  process.exit(0);
} catch (err) {
  console.error('Failed to read/parse OpenAPI spec:', err.message);
  process.exit(1);
}
