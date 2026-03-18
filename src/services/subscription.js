const { getPool } = require('../config/database');
const { generateEmbedding } = require('./ollama');

/**
 * Determine subscription tier for an account.
 * - Open: no first_contribution_at or reputation < 0 → 3 subs max
 * - Contributor: has first_contribution_at and reputation >= 0 → 20 subs max
 * - Trusted: badge_contribution = true → unlimited
 */
async function getTier(accountId) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT reputation_contribution, badge_contribution, first_contribution_at FROM accounts WHERE id = $1',
    [accountId]
  );

  if (rows.length === 0) {
    return { tier: 'open', limit: 3 };
  }

  const account = rows[0];

  if (account.badge_contribution === true) {
    return { tier: 'trusted', limit: Infinity };
  }

  if (account.first_contribution_at && (account.reputation_contribution || 0) >= 0) {
    return { tier: 'contributor', limit: 20 };
  }

  return { tier: 'open', limit: 3 };
}

/**
 * Create a new subscription after validating tier limits and type-specific fields.
 */
async function createSubscription({
  accountId,
  type,
  topicId,
  keyword,
  embeddingText,
  similarityThreshold,
  lang,
  notificationMethod,
  webhookUrl,
}) {
  const pool = getPool();

  // Check tier limit
  const { tier, limit } = await getTier(accountId);
  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM subscriptions WHERE account_id = $1 AND active = true',
    [accountId]
  );
  const activeCount = countRows[0].count;

  if (activeCount >= limit) {
    const err = new Error(`Subscription limit reached for tier "${tier}" (max ${limit})`);
    err.code = 'LIMIT_REACHED';
    throw err;
  }

  // Type-specific validation and field preparation
  let embedding = null;
  const threshold = similarityThreshold ?? (type === 'vector' ? 0.8 : null);

  if (type === 'topic') {
    if (!topicId) {
      const err = new Error('topicId is required for topic subscriptions');
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
  } else if (type === 'keyword') {
    if (!keyword || keyword.length < 3 || keyword.length > 255) {
      const err = new Error('Keyword must be between 3 and 255 characters');
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
  } else if (type === 'vector') {
    if (!embeddingText) {
      const err = new Error('embeddingText is required for vector subscriptions');
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
    embedding = await generateEmbedding(embeddingText);
    if (!embedding) {
      const err = new Error('Failed to generate embedding — Ollama may be unavailable');
      err.code = 'EMBEDDING_FAILED';
      throw err;
    }
  }

  const embeddingValue = embedding ? `[${embedding.join(',')}]` : null;

  const { rows } = await pool.query(
    `INSERT INTO subscriptions (account_id, type, topic_id, keyword, embedding, similarity_threshold, lang, notification_method, webhook_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, account_id, type, topic_id, keyword, similarity_threshold, lang, notification_method, webhook_url, active, created_at`,
    [
      accountId,
      type,
      type === 'topic' ? topicId : null,
      type === 'keyword' ? keyword : null,
      embeddingValue,
      threshold,
      lang || null,
      notificationMethod || 'webhook',
      webhookUrl || null,
    ]
  );

  return rows[0];
}

/**
 * List subscriptions for an account, paginated.
 */
async function listMySubscriptions(accountId, { page = 1, limit = 20 } = {}) {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      `SELECT id, account_id, type, topic_id, keyword, similarity_threshold, lang, notification_method, webhook_url, active, created_at
       FROM subscriptions
       WHERE account_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [accountId, limit, offset]
    ),
    pool.query(
      'SELECT COUNT(*)::int AS total FROM subscriptions WHERE account_id = $1',
      [accountId]
    ),
  ]);

  return {
    data: dataResult.rows,
    pagination: {
      page,
      limit,
      total: countResult.rows[0].total,
    },
  };
}

/**
 * Update a subscription. Verifies ownership.
 */
async function updateSubscription(id, accountId, { similarityThreshold, webhookUrl, active, lang }) {
  const pool = getPool();

  // Verify ownership
  const { rows: existing } = await pool.query(
    'SELECT id, account_id FROM subscriptions WHERE id = $1',
    [id]
  );

  if (existing.length === 0) {
    const err = new Error('Subscription not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (existing[0].account_id !== accountId) {
    const err = new Error('Not authorized to update this subscription');
    err.code = 'FORBIDDEN';
    throw err;
  }

  // Build dynamic SET clause
  const sets = [];
  const values = [];
  let paramIndex = 1;

  if (similarityThreshold !== undefined) {
    sets.push(`similarity_threshold = $${paramIndex++}`);
    values.push(similarityThreshold);
  }
  if (webhookUrl !== undefined) {
    sets.push(`webhook_url = $${paramIndex++}`);
    values.push(webhookUrl);
  }
  if (active !== undefined) {
    sets.push(`active = $${paramIndex++}`);
    values.push(active);
  }
  if (lang !== undefined) {
    sets.push(`lang = $${paramIndex++}`);
    values.push(lang);
  }

  if (sets.length === 0) {
    const err = new Error('No fields to update');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  values.push(id);

  const { rows } = await pool.query(
    `UPDATE subscriptions SET ${sets.join(', ')} WHERE id = $${paramIndex}
     RETURNING id, account_id, type, topic_id, keyword, similarity_threshold, lang, notification_method, webhook_url, active, created_at`,
    values
  );

  return rows[0];
}

/**
 * Delete a subscription. Verifies ownership.
 */
async function deleteSubscription(id, accountId) {
  const pool = getPool();

  const { rows: existing } = await pool.query(
    'SELECT id, account_id FROM subscriptions WHERE id = $1',
    [id]
  );

  if (existing.length === 0) {
    const err = new Error('Subscription not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (existing[0].account_id !== accountId) {
    const err = new Error('Not authorized to delete this subscription');
    err.code = 'FORBIDDEN';
    throw err;
  }

  await pool.query('DELETE FROM subscriptions WHERE id = $1', [id]);
}

/**
 * Get a subscription by ID (internal use).
 */
async function getSubscriptionById(id) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, account_id, type, topic_id, keyword, similarity_threshold, lang, notification_method, webhook_url, active, created_at
     FROM subscriptions WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

module.exports = {
  getTier,
  createSubscription,
  listMySubscriptions,
  updateSubscription,
  deleteSubscription,
  getSubscriptionById,
};
