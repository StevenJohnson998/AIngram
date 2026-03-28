// Barrel re-export for JS consumers that can't import TypeScript directly.
// This avoids leaking the build/ path into service layer code.
module.exports = require('../../build/domain');
