/**
 * AIngram Worker Process
 * Runs background jobs: timeout enforcement, abuse detection, reputation recalculation.
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

const { checkTimeouts } = require('./timeout-enforcer');
const { runAllDetections } = require('../services/abuse-detection');
const { recalculateAllBatched } = require('../services/reputation');
const { TIMEOUT_CHECK_MS } = require('../config/protocol');
const { retryNotifications } = require('../services/notification');
const { processRestorations } = require('./counter-notice-restorer');
const { T_RESTORATION_CHECK_MS, T_ANALYTICS_REFRESH_MS, T_DIRECTIVES_REGEN_MS, T_EMBEDDING_RETRY_MS } = require('../config/protocol');
const { refreshViews } = require('../services/copyright-analytics');
const { generateCopyrightDirective } = require('../services/dynamic-directives');
const { retryPendingEmbeddings } = require('../services/embedding');
const { processPendingReviews } = require('../services/guardian');

// Timeout enforcer: every 5 minutes (fast-track merge + review/dispute timeouts)
const timeoutInterval = setInterval(checkTimeouts, TIMEOUT_CHECK_MS);
console.log(`Worker: timeout enforcer started (interval: ${TIMEOUT_CHECK_MS}ms)`);

// Abuse detection: every 5 minutes
const abuseInterval = setInterval(runAllDetections, 5 * 60 * 1000);
console.log('Worker: abuse detection job started (interval: 5m)');

// Reputation recalculation: every hour, batched (safety net — incremental recalc happens per-vote)
const reputationInterval = setInterval(
  () => recalculateAllBatched({ batchSize: 50, pauseMs: 100 }),
  60 * 60 * 1000
);
console.log('Worker: reputation recalc job started (interval: 1h)');

// Notification retry: every 30 seconds (webhook DLQ)
const notificationRetryInterval = setInterval(retryNotifications, 30 * 1000);
console.log('Worker: notification retry job started (interval: 30s)');

// Counter-notice restoration: every hour (restore chunks after legal delay)
const restorationInterval = setInterval(processRestorations, T_RESTORATION_CHECK_MS);
console.log(`Worker: counter-notice restoration job started (interval: ${T_RESTORATION_CHECK_MS}ms)`);

// Copyright analytics: refresh materialized views (Sprint 7)
const analyticsInterval = setInterval(refreshViews, T_ANALYTICS_REFRESH_MS);
console.log(`Worker: copyright analytics refresh started (interval: ${T_ANALYTICS_REFRESH_MS}ms)`);

// Dynamic directives: regenerate enriched reviewer guidelines (Sprint 7b)
const directivesInterval = setInterval(generateCopyrightDirective, T_DIRECTIVES_REGEN_MS);
console.log(`Worker: dynamic directives regen started (interval: ${T_DIRECTIVES_REGEN_MS}ms)`);

// Embedding retry: recover chunks with NULL embeddings (Ollama failures)
const embeddingRetryInterval = setInterval(retryPendingEmbeddings, T_EMBEDDING_RETRY_MS);
console.log(`Worker: embedding retry job started (interval: ${T_EMBEDDING_RETRY_MS}ms)`);

// Guardian quarantine review: process pending reviews every 10 seconds
const GUARDIAN_POLL_MS = parseInt(process.env.GUARDIAN_POLL_MS || '10000', 10);
const guardianInterval = setInterval(processPendingReviews, GUARDIAN_POLL_MS);
console.log(`Worker: guardian review job started (interval: ${GUARDIAN_POLL_MS}ms)`);

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

server.listen(3001, '127.0.0.1', () => {
  console.log('Worker: health check listening on :3001');
});

// Graceful shutdown
async function shutdown() {
  console.log('Worker: shutting down...');
  clearInterval(timeoutInterval);
  clearInterval(abuseInterval);
  clearInterval(reputationInterval);
  clearInterval(notificationRetryInterval);
  clearInterval(restorationInterval);
  clearInterval(analyticsInterval);
  clearInterval(directivesInterval);
  clearInterval(embeddingRetryInterval);
  clearInterval(guardianInterval);
  server.close();
  await closePool();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
