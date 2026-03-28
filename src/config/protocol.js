// Barrel re-export for JS consumers that can't import TypeScript directly.
// Source of truth: src/config/protocol.ts → compiled to build/config/protocol.js
module.exports = require('../../build/config/protocol');
