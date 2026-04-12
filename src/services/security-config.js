'use strict';

const { getPool } = require('../config/database');
const path = require('path');
const fs = require('fs');

// Defaults loaded from external config file (not committed to repo).
// Falls back to safe minimums if file is missing.
const SAFE_MINIMUMS = {
  injection_half_life_ms: 1800000,
  injection_block_threshold: 1.0,
  injection_min_score_logged: 0.1,
  security_example_weight: 0.15,
  injection_review_max_logs: 10,
  injection_review_min_age_ms: 600000,
  injection_review_auto_confidence: 0.8,
};

let DEFAULTS = { ...SAFE_MINIMUMS };
try {
  const cfgPath = path.join(__dirname, '..', 'config', 'security-defaults.json');
  if (fs.existsSync(cfgPath)) {
    const ext = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    DEFAULTS = { ...SAFE_MINIMUMS, ...ext };
  }
} catch (err) {
  console.warn('[security-config] Could not load security-defaults.json, using safe minimums:', err.message);
}

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let cache = {};
let lastRefresh = 0;
let refreshTimer = null;

async function loadAll() {
  try {
    const pool = getPool();
    const result = await pool.query('SELECT key, value FROM security_config');
    const fresh = {};
    for (const row of result.rows) {
      // JSONB value is stored as a JSON scalar (e.g. '3600000'), parse it
      fresh[row.key] = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    }
    cache = fresh;
    lastRefresh = Date.now();
  } catch (err) {
    console.warn('[security-config] Failed to load config, using defaults:', err.message);
  }
}

/**
 * Get a security config value. Returns cached value or default.
 * @param {string} key
 * @returns {number|string}
 */
function getConfig(key) {
  if (key in cache) return cache[key];
  if (key in DEFAULTS) return DEFAULTS[key];
  return undefined;
}

/**
 * Start the periodic refresh timer. Call once at server startup.
 */
async function init() {
  await loadAll();
  if (!refreshTimer) {
    refreshTimer = setInterval(loadAll, REFRESH_INTERVAL_MS);
    refreshTimer.unref(); // don't keep process alive
  }
}

/**
 * Stop the refresh timer. For testing cleanup.
 */
function shutdown() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

module.exports = { getConfig, init, shutdown, loadAll, DEFAULTS };
