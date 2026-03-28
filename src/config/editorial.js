/**
 * Legacy re-export shim — all constants now live in protocol.ts.
 * TODO: Remove after Sprint 2 (update all consumers to use config/protocol).
 */
const protocol = require('./protocol');

module.exports = {
  MERGE_TIMEOUT_LOW_SENSITIVITY_MS: protocol.MERGE_TIMEOUT_LOW_SENSITIVITY_MS,
  MERGE_TIMEOUT_HIGH_SENSITIVITY_MS: protocol.MERGE_TIMEOUT_HIGH_SENSITIVITY_MS,
  AUTO_MERGE_CHECK_INTERVAL_MS: protocol.AUTO_MERGE_CHECK_INTERVAL_MS,
};
