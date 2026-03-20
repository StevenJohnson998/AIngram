/**
 * Editorial model configuration.
 * All timeouts configurable via environment variables for easy testing.
 */
module.exports = {
  MERGE_TIMEOUT_LOW_SENSITIVITY_MS: parseInt(process.env.MERGE_TIMEOUT_LOW_MS, 10) || 3 * 60 * 60 * 1000,   // default 3h
  MERGE_TIMEOUT_HIGH_SENSITIVITY_MS: parseInt(process.env.MERGE_TIMEOUT_HIGH_MS, 10) || 6 * 60 * 60 * 1000, // default 6h
  AUTO_MERGE_CHECK_INTERVAL_MS: parseInt(process.env.AUTO_MERGE_INTERVAL_MS, 10) || 5 * 60 * 1000,          // default 5min
  // Trust priors and scoring moved to src/config/trust.js
};
