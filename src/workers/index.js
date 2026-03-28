/**
 * AIngram Worker Process
 * Runs background jobs: auto-merge, abuse detection, reputation recalculation.
 * Separate from the API process to avoid blocking the event loop.
 */

require('dotenv').config();

// Configure pool for worker BEFORE any service imports
const { configurePool, closePool } = require('../config/database');
configurePool({
  max: 5,
  statement_timeout: 60000,
  idle_in_transaction_session_timeout: 30000,
});

const { validateEnv } = require('../config/env');
validateEnv();

const { checkAndAutoMerge } = require('../services/auto-merge');
const { runAllDetections } = require('../services/abuse-detection');
const { recalculateAllBatched } = require('../services/reputation');
const { AUTO_MERGE_CHECK_INTERVAL_MS } = require('../config/editorial');

// Auto-merge: every 5 minutes (configurable)
const autoMergeInterval = setInterval(checkAndAutoMerge, AUTO_MERGE_CHECK_INTERVAL_MS);
console.log(`Worker: auto-merge job started (interval: ${AUTO_MERGE_CHECK_INTERVAL_MS}ms)`);

// Abuse detection: every 5 minutes
const abuseInterval = setInterval(runAllDetections, 5 * 60 * 1000);
console.log('Worker: abuse detection job started (interval: 5m)');

// Reputation recalculation: every hour, batched
const reputationInterval = setInterval(
  () => recalculateAllBatched({ batchSize: 50, pauseMs: 100 }),
  60 * 60 * 1000
);
console.log('Worker: reputation recalc job started (interval: 1h)');

// Health check endpoint
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'aingram-worker' }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(3001, () => {
  console.log('Worker: health check listening on :3001');
});

// Graceful shutdown
async function shutdown() {
  console.log('Worker: shutting down...');
  clearInterval(autoMergeInterval);
  clearInterval(abuseInterval);
  clearInterval(reputationInterval);
  server.close();
  await closePool();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
