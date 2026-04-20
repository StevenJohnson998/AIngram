#!/usr/bin/env node
/**
 * One-time migration: pull discussion messages from the Agorai sidecar
 * and insert them into the native `messages` table.
 *
 * Must run while Agorai is still up.
 *
 * Usage:
 *   DATABASE_URL=postgres://... AGORAI_URL=http://... node scripts/migrate-agorai-messages.js
 *
 * Idempotent: skips messages already present (matched by topic_id + content + created_at).
 */

'use strict';

const pg = require('pg');

const AGORAI_URL = process.env.AGORAI_URL || 'http://localhost:3200';
const DATABASE_URL = process.env.DATABASE_URL ||
  (process.env.DB_HOST
    ? `postgres://${process.env.DB_USER || 'admin'}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME}`
    : null);

if (!DATABASE_URL) {
  console.error('DATABASE_URL or DB_HOST/DB_USER/DB_PASSWORD/DB_NAME is required');
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    // 1. Find all topics linked to an Agorai conversation
    const { rows: topics } = await pool.query(
      `SELECT id, title, agorai_conversation_id
       FROM topics
       WHERE agorai_conversation_id IS NOT NULL`
    );

    console.log(`Found ${topics.length} topics with Agorai conversations`);
    if (topics.length === 0) {
      console.log('Nothing to migrate.');
      return;
    }

    // 2. Build activity_log lookup for account matching
    const { rows: activityLogs } = await pool.query(
      `SELECT al.account_id, a.name, a.type, al.target_id AS topic_id, al.created_at
       FROM activity_log al
       JOIN accounts a ON a.id = al.account_id
       WHERE al.action = 'discussion_post' AND al.target_type = 'topic'
       ORDER BY al.created_at ASC`
    );

    const logsByTopic = {};
    for (const log of activityLogs) {
      if (!logsByTopic[log.topic_id]) logsByTopic[log.topic_id] = [];
      logsByTopic[log.topic_id].push(log);
    }

    let migrated = 0;
    let skipped = 0;
    let unmatched = 0;

    for (const topic of topics) {
      const convId = topic.agorai_conversation_id;

      // 3. Fetch messages from Agorai REST API (public, no auth)
      let messages = [];
      try {
        const res = await fetch(`${AGORAI_URL}/api/conversations/${convId}/public?limit=1000`);
        if (!res.ok) {
          console.warn(`  [${topic.title}] Agorai returned ${res.status}, skipping`);
          continue;
        }
        const data = await res.json();
        messages = data.messages || data || [];
      } catch (err) {
        console.warn(`  [${topic.title}] Agorai fetch error: ${err.message}, skipping`);
        continue;
      }

      if (messages.length === 0) continue;
      console.log(`  [${topic.title}] ${messages.length} messages to migrate`);

      const topicLogs = logsByTopic[topic.id] || [];

      for (const msg of messages) {
        const content = msg.content;
        const createdAt = msg.createdAt || msg.created_at;
        if (!content || !createdAt) continue;

        // Match account: try metadata first, then activity_log timestamp
        let accountId = null;
        if (msg.metadata && msg.metadata.accountId) {
          accountId = msg.metadata.accountId;
        } else {
          const msgTime = new Date(createdAt).getTime();
          const match = topicLogs.find(log =>
            Math.abs(new Date(log.created_at).getTime() - msgTime) < 2000
          );
          if (match) accountId = match.account_id;
        }

        if (!accountId) {
          console.warn(`    Unmatched message at ${createdAt}: "${content.slice(0, 60)}..."`);
          unmatched++;
          continue;
        }

        // Idempotency check
        const { rows: existing } = await pool.query(
          `SELECT id FROM messages
           WHERE topic_id = $1 AND content = $2 AND created_at = $3`,
          [topic.id, content, createdAt]
        );
        if (existing.length > 0) {
          skipped++;
          continue;
        }

        const level = (msg.metadata && msg.metadata.level) || 1;

        await pool.query(
          `INSERT INTO messages (topic_id, account_id, content, level, type, created_at)
           VALUES ($1, $2, $3, $4, 'contribution', $5)`,
          [topic.id, accountId, content, level, createdAt]
        );
        migrated++;
      }
    }

    console.log(`\nDone. Migrated: ${migrated}, Skipped (duplicate): ${skipped}, Unmatched: ${unmatched}`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
