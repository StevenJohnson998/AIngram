const { getPool } = require('../config/database');
const { sendSubscriptionMatchEmail } = require('./email');

const WEBHOOK_TIMEOUT_MS = 5000;
const MAX_NOTIFS_PER_MIN = 10;
const THROTTLE_WINDOW_MS = 60 * 1000;
const RETRY_BACKOFFS_MS = [1000, 10000, 60000]; // 1s, 10s, 60s

// In-memory throttle tracker: accountId -> { count, windowStart }
const throttleMap = new Map();

/**
 * Dispatch a notification for a subscription match.
 * Fire-and-forget: logs errors but never throws.
 *
 * @param {Object} subscription - The subscription record
 * @param {Object} match - Match info { chunkId, matchType, similarity, contentPreview }
 */
async function dispatchNotification(subscription, match) {
  try {
    // Throttle check: max MAX_NOTIFS_PER_MIN per subscriber per minute
    if (isThrottled(subscription.account_id)) {
      // Queue for digest instead of immediate dispatch
      await enqueueNotification(subscription.id, match, 'throttled');
      return;
    }
    incrementThrottle(subscription.account_id);

    if (subscription.notification_method === 'webhook') {
      const result = await dispatchWebhook(subscription, match);
      if (!result.success) {
        // Enqueue for retry on failure
        await enqueueNotification(subscription.id, match, result.error || 'webhook_failed');
      }
    } else if (subscription.notification_method === 'a2a') {
      // TODO: A2A protocol integration (Phase 2)
      console.log(`a2a notification stub: subscription=${subscription.id}, chunk=${match.chunkId}`);
    } else if (subscription.notification_method === 'email') {
      await dispatchEmail(subscription, match);
    } else if (subscription.notification_method === 'polling') {
      // Polling subscriptions are passive — matched on query, no push needed
    }
  } catch (err) {
    console.error(`Notification dispatch error for subscription ${subscription.id}:`, err.message);
  }
}

/**
 * Throttle helpers — in-memory, resets on restart (acceptable).
 */
function isThrottled(accountId) {
  const entry = throttleMap.get(accountId);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > THROTTLE_WINDOW_MS) {
    throttleMap.delete(accountId);
    return false;
  }
  return entry.count >= MAX_NOTIFS_PER_MIN;
}

function incrementThrottle(accountId) {
  const entry = throttleMap.get(accountId);
  const now = Date.now();
  if (!entry || now - entry.windowStart > THROTTLE_WINDOW_MS) {
    throttleMap.set(accountId, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
}

/**
 * Enqueue a failed/throttled notification for retry.
 */
async function enqueueNotification(subscriptionId, match, error) {
  try {
    const pool = getPool();
    const nextRetry = new Date(Date.now() + RETRY_BACKOFFS_MS[0]);
    await pool.query(
      `INSERT INTO notification_queue (subscription_id, payload, next_retry_at, last_error, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [subscriptionId, JSON.stringify(match), nextRetry, error]
    );
  } catch (err) {
    console.error(`Failed to enqueue notification for subscription ${subscriptionId}:`, err.message);
  }
}

/**
 * Retry pending notifications (called by worker).
 * Picks up to 50 pending items, retries webhook, applies exponential backoff.
 */
async function retryNotifications() {
  const pool = getPool();

  const { rows: pending } = await pool.query(
    `SELECT nq.*, s.webhook_url, s.account_id, s.notification_method
     FROM notification_queue nq
     JOIN subscriptions s ON s.id = nq.subscription_id
     WHERE nq.status IN ('pending', 'retrying')
       AND nq.next_retry_at <= now()
     ORDER BY nq.next_retry_at ASC
     LIMIT 50
     FOR UPDATE OF nq SKIP LOCKED`
  );

  let delivered = 0;
  let deadLettered = 0;

  for (const item of pending) {
    const match = item.payload;
    const subscription = {
      id: item.subscription_id,
      webhook_url: item.webhook_url,
      account_id: item.account_id,
      notification_method: item.notification_method,
    };

    const result = await dispatchWebhook(subscription, match);

    if (result.success) {
      await pool.query(
        `UPDATE notification_queue SET status = 'delivered', delivered_at = now()
         WHERE id = $1`,
        [item.id]
      );
      delivered++;
    } else {
      const newAttempts = item.attempts + 1;
      if (newAttempts >= item.max_attempts) {
        await pool.query(
          `UPDATE notification_queue SET status = 'dead_letter', attempts = $2, last_error = $3
           WHERE id = $1`,
          [item.id, newAttempts, result.error || 'max_attempts_reached']
        );
        deadLettered++;
      } else {
        const backoff = RETRY_BACKOFFS_MS[Math.min(newAttempts, RETRY_BACKOFFS_MS.length - 1)];
        const nextRetry = new Date(Date.now() + backoff);
        await pool.query(
          `UPDATE notification_queue SET status = 'retrying', attempts = $2, next_retry_at = $3, last_error = $4
           WHERE id = $1`,
          [item.id, newAttempts, nextRetry, result.error || 'retry']
        );
      }
    }
  }

  if (delivered > 0 || deadLettered > 0) {
    console.log(`Notification retry: ${delivered} delivered, ${deadLettered} dead-lettered`);
  }

  return { delivered, deadLettered, processed: pending.length };
}

/**
 * List dead-letter notifications (admin).
 */
async function listDeadLetters({ page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const countResult = await pool.query(
    "SELECT COUNT(*)::int AS total FROM notification_queue WHERE status = 'dead_letter'"
  );
  const total = countResult.rows[0].total;

  const dataResult = await pool.query(
    `SELECT nq.*, s.webhook_url
     FROM notification_queue nq
     JOIN subscriptions s ON s.id = nq.subscription_id
     WHERE nq.status = 'dead_letter'
     ORDER BY nq.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return {
    data: dataResult.rows,
    pagination: { page, limit, total },
  };
}

/**
 * POST to webhook_url with match payload. 5s timeout.
 */
function isPrivateUrl(urlString) {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return true;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    if (hostname === 'metadata.google.internal') return true;
    if (hostname.endsWith('.internal') || hostname.endsWith('.local')) return true;
    // Block RFC 1918 ranges
    const parts = hostname.split('.').map(Number);
    if (parts.length === 4 && parts.every((p) => !isNaN(p))) {
      if (parts[0] === 10) return true;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      if (parts[0] === 192 && parts[1] === 168) return true;
      if (parts[0] === 169 && parts[1] === 254) return true; // link-local
    }
    return false;
  } catch {
    return true;
  }
}

async function dispatchWebhook(subscription, match) {
  if (!subscription.webhook_url) {
    console.warn(`Webhook subscription ${subscription.id} has no webhook_url`);
    return { success: false, error: 'No webhook URL configured' };
  }

  if (isPrivateUrl(subscription.webhook_url)) {
    console.warn(`Webhook blocked (private URL) for subscription ${subscription.id}`);
    return { success: false, error: 'Webhook URL points to a private/internal address' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const payload = {
      subscriptionId: subscription.id,
      matchType: match.matchType,
      chunkId: match.chunkId,
      similarity: match.similarity || null,
      content_preview: match.contentPreview || null,
      title: match.title || null,
      subtitle: match.subtitle || null,
    };

    const response = await fetch(subscription.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`Webhook failed for subscription ${subscription.id}: HTTP ${response.status}`);
      return { success: false, status: response.status };
    }

    return { success: true, status: response.status };
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`Webhook timed out for subscription ${subscription.id}`);
      return { success: false, error: 'timeout' };
    }
    console.warn(`Webhook error for subscription ${subscription.id}: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send subscription match notification via email.
 */
async function dispatchEmail(subscription, match) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT owner_email FROM accounts WHERE id = $1',
    [subscription.account_id]
  );

  if (rows.length === 0 || !rows[0].owner_email) {
    console.warn(`Email dispatch: no email for account ${subscription.account_id}`);
    return { success: false, error: 'No email address' };
  }

  await sendSubscriptionMatchEmail(rows[0].owner_email, match, subscription);
  return { success: true };
}

/**
 * Get recent matching chunks for an account's polling subscriptions.
 * For each active polling subscription, find recent chunks that match.
 *
 * @param {string} accountId
 * @param {Object} options - { since (ISO date), limit }
 */
async function getPendingNotifications(accountId, { since, limit = 20 } = {}) {
  const pool = getPool();

  const sinceDate = since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Get active polling subscriptions for this account
  const { rows: subs } = await pool.query(
    `SELECT id, type, topic_id, keyword, embedding, similarity_threshold, lang
     FROM subscriptions
     WHERE account_id = $1 AND active = true AND notification_method = 'polling'`,
    [accountId]
  );

  if (subs.length === 0) {
    return { data: [], pagination: { page: 1, limit, total: 0 } };
  }

  const notifications = [];

  // Group subscriptions by type and batch queries
  const topicSubs = subs.filter((s) => s.type === 'topic' && s.topic_id);
  const keywordSubs = subs.filter((s) => s.type === 'keyword' && s.keyword);
  const vectorSubs = subs.filter((s) => s.type === 'vector' && s.embedding);

  // Batch topic subscriptions: single query for all topic_ids
  if (topicSubs.length > 0) {
    const topicIds = topicSubs.map((s) => s.topic_id);
    const topicIdToSubId = new Map(topicSubs.map((s) => [s.topic_id, s.id]));
    const placeholders = topicIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `SELECT c.id as chunk_id, c.content, c.title, c.subtitle, c.created_at, ct.topic_id
       FROM chunks c
       JOIN chunk_topics ct ON ct.chunk_id = c.id
       WHERE ct.topic_id IN (${placeholders}) AND c.created_at >= $${topicIds.length + 1}
       ORDER BY c.created_at DESC`,
      [...topicIds, sinceDate]
    );
    for (const chunk of rows) {
      notifications.push({
        subscriptionId: topicIdToSubId.get(chunk.topic_id),
        matchType: 'topic',
        chunkId: chunk.chunk_id,
        contentPreview: chunk.content.slice(0, 200),
        title: chunk.title || null,
        subtitle: chunk.subtitle || null,
        createdAt: chunk.created_at,
      });
    }
  }

  // Batch keyword subscriptions: single query with OR conditions
  if (keywordSubs.length > 0) {
    const escapedKeywords = keywordSubs.map((s) => ({
      subId: s.id,
      pattern: `%${s.keyword.replace(/[%_\\]/g, '\\$&')}%`,
    }));
    const ilikeParts = escapedKeywords.map((_, i) => `content ILIKE $${i + 1} ESCAPE '\\'`);
    const { rows } = await pool.query(
      `SELECT id as chunk_id, content, title, subtitle, created_at
       FROM chunks
       WHERE (${ilikeParts.join(' OR ')}) AND created_at >= $${escapedKeywords.length + 1}
       ORDER BY created_at DESC`,
      [...escapedKeywords.map((k) => k.pattern), sinceDate]
    );
    // Match each chunk back to its subscription(s)
    for (const chunk of rows) {
      for (const kw of keywordSubs) {
        const escapedKw = kw.keyword.replace(/[%_\\]/g, '\\$&').toLowerCase();
        if (chunk.content.toLowerCase().includes(kw.keyword.toLowerCase())) {
          notifications.push({
            subscriptionId: kw.id,
            matchType: 'keyword',
            chunkId: chunk.chunk_id,
            contentPreview: chunk.content.slice(0, 200),
            title: chunk.title || null,
            subtitle: chunk.subtitle || null,
            createdAt: chunk.created_at,
          });
        }
      }
    }
  }

  // Batch vector subscriptions: single query with multiple cosine comparisons
  if (vectorSubs.length > 0) {
    const caseParts = [];
    const whereParts = [];
    const params = [sinceDate];
    let idx = 2;

    for (const sub of vectorSubs) {
      const threshold = sub.similarity_threshold || 0.8;
      const embIdx = idx++;
      const threshIdx = idx++;
      params.push(sub.embedding, threshold);
      whereParts.push(`1 - (embedding <=> $${embIdx}::vector) >= $${threshIdx}`);
      caseParts.push(
        `WHEN 1 - (embedding <=> $${embIdx}::vector) >= $${threshIdx} THEN json_build_object('subId', '${sub.id}'::text, 'similarity', 1 - (embedding <=> $${embIdx}::vector))`
      );
    }

    const { rows } = await pool.query(
      `SELECT id as chunk_id, content, title, subtitle, created_at,
              (CASE ${caseParts.join(' ')} END) as match_info
       FROM chunks
       WHERE embedding IS NOT NULL
         AND created_at >= $1
         AND (${whereParts.join(' OR ')})
       ORDER BY created_at DESC`,
      params
    );

    for (const chunk of rows) {
      if (chunk.match_info) {
        notifications.push({
          subscriptionId: chunk.match_info.subId,
          matchType: 'vector',
          chunkId: chunk.chunk_id,
          similarity: parseFloat(chunk.match_info.similarity),
          contentPreview: chunk.content.slice(0, 200),
          title: chunk.title || null,
          subtitle: chunk.subtitle || null,
          createdAt: chunk.created_at,
        });
      }
    }
  }

  // Sort by creation date, most recent first, and apply limit
  notifications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const limited = notifications.slice(0, limit);

  return {
    data: limited,
    pagination: { page: 1, limit, total: notifications.length },
  };
}

module.exports = {
  dispatchNotification,
  dispatchWebhook,
  getPendingNotifications,
  retryNotifications,
  listDeadLetters,
  // Exposed for testing
  _throttleMap: throttleMap,
  MAX_NOTIFS_PER_MIN,
};
