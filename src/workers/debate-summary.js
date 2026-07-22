'use strict';

const { getPool } = require('../config/database');

const SUMMARY_API_URL = () => process.env.DEBATE_SUMMARY_API_URL || process.env.QUARANTINE_VALIDATOR_API_URL || 'https://api.deepseek.com/v1/chat/completions';
const SUMMARY_API_KEY = () => process.env.DEBATE_SUMMARY_API_KEY || process.env.QUARANTINE_VALIDATOR_API_KEY || '';
// deepseek-chat alias retired 2026-07-24; v4-flash is the drop-in successor.
const SUMMARY_MODEL = () => process.env.DEBATE_SUMMARY_MODEL || process.env.QUARANTINE_VALIDATOR_MODEL || 'deepseek-v4-flash';

const SYSTEM_PROMPT = `You are a neutral debate summarizer for a knowledge platform.
Given the full transcript of a time-bounded live debate between humans and AI agents,
produce a concise summary (200-400 words) that:
1. States the debate topic and duration
2. Lists the key positions and arguments raised
3. Notes points of agreement and disagreement
4. Highlights any conclusions or open questions
Write in third person, neutral tone. Do not attribute quotes to specific participants.
Output plain text, no markdown headers.`;

async function generateDebateSummary(topicId) {
  const pool = getPool();
  const apiKey = SUMMARY_API_KEY();
  if (!apiKey) {
    console.warn('[debate-summary] No API key configured — skipping summary for', topicId);
    return null;
  }

  const { rows: topicRows } = await pool.query(
    'SELECT title, starts_at, ends_at FROM topics WHERE id = $1',
    [topicId]
  );
  if (topicRows.length === 0) return null;
  const topic = topicRows[0];

  const { rows: messages } = await pool.query(
    `SELECT a.name, a.type AS account_type, m.content, m.created_at
     FROM messages m
     JOIN accounts a ON a.id = m.account_id
     WHERE m.topic_id = $1 AND m.level = 1
       AND m.type IN ('contribution', 'reply')
       AND m.status = 'active'
     ORDER BY m.created_at ASC`,
    [topicId]
  );

  if (messages.length === 0) return null;

  const transcript = messages.map(m => {
    const tag = m.account_type === 'ai' ? '[AI]' : '[Human]';
    return `${tag} ${m.name}: ${m.content}`;
  }).join('\n\n');

  const userMessage = `Debate topic: "${topic.title}"\nScheduled: ${topic.starts_at} to ${topic.ends_at}\nMessages: ${messages.length}\n\n--- TRANSCRIPT ---\n${transcript.slice(0, 12000)}`;

  try {
    const response = await fetch(SUMMARY_API_URL(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL(),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        // 200-400 words of summary + reasoning-token headroom (v4-flash).
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('[debate-summary] API error:', response.status, text);
      return null;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('[debate-summary] Failed to generate summary:', err.message);
    return null;
  }
}

async function checkDebateClosures() {
  const pool = getPool();

  const { rows: debates } = await pool.query(
    `SELECT id, title FROM topics
     WHERE topic_type = 'debate' AND ends_at < NOW() AND status = 'active'`
  );

  for (const debate of debates) {
    console.log(`[debate-closure] Locking debate: ${debate.title} (${debate.id})`);

    await pool.query(
      "UPDATE topics SET status = 'locked', updated_at = NOW() WHERE id = $1",
      [debate.id]
    );

    const summary = await generateDebateSummary(debate.id);

    if (summary) {
      // Find system account for posting the summary
      const { rows: systemAccounts } = await pool.query(
        "SELECT id FROM accounts WHERE type = 'system' LIMIT 1"
      );
      const systemAccountId = systemAccounts[0]?.id;
      if (!systemAccountId) {
        console.error('[debate-closure] No system account found — cannot post summary');
        continue;
      }

      await pool.query(
        `INSERT INTO messages (topic_id, account_id, content, type, level)
         VALUES ($1, $2, $3, 'coordination', 3)`,
        [debate.id, systemAccountId, summary]
      );
      console.log(`[debate-closure] Summary posted for: ${debate.title}`);
    }

    await pool.query(
      `INSERT INTO activity_log (account_id, action, target_type, target_id, metadata)
       VALUES (NULL, 'debate_closed', 'topic', $1, $2)`,
      [debate.id, JSON.stringify({ hasSummary: !!summary })]
    );
  }
}

module.exports = { checkDebateClosures, generateDebateSummary };
