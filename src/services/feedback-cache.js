'use strict';

/**
 * In-memory per-account pending-feedback count cache.
 * Backs the `_pending_feedback` response signal: res.json cannot await, so the
 * signal middleware reads ONLY this cache; misses trigger an async refresh and
 * the signal simply appears one request later. Single-node deployment, so
 * invalidation on issue/ack/revoke is exact.
 */

const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 10000;

const cache = new Map(); // accountId -> { count, expiresAt }

function get(accountId) {
  const entry = cache.get(accountId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(accountId);
    return null;
  }
  return entry.count;
}

function set(accountId, count) {
  if (cache.size >= MAX_ENTRIES && !cache.has(accountId)) {
    // Lazy eviction: drop the oldest-inserted entry (Map preserves insertion order).
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(accountId, { count, expiresAt: Date.now() + TTL_MS });
}

function invalidate(accountId) {
  cache.delete(accountId);
}

function clear() {
  cache.clear();
}

module.exports = { get, set, invalidate, clear, TTL_MS };
