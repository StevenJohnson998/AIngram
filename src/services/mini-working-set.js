'use strict';

const { getPool } = require('../config/database');

/**
 * Return an account's most recent chunk contributions for LLM-mode coherence
 * simulation (ADR D95). Only used when endpoint_kind = 'llm' —
 * agent mode has its own persistent session memory and does not need this.
 *
 * Titles + subtitles are sufficient to let the LLM avoid exact duplicates and
 * maintain a consistent voice across clicks. Full content is intentionally
 * not included (payload discipline + cache prefix stability).
 *
 * @param {string} accountId
 * @param {{limit?: number}} [opts]
 * @returns {Promise<Array<{id: string, title: string, subtitle: string|null, createdAt: Date}>>}
 */
async function getRecentContributions(accountId, { limit = 5 } = {}) {
  if (!accountId) return [];
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, title, subtitle, created_at
     FROM chunks
     WHERE created_by = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [accountId, limit]
  );
  return result.rows.map(r => ({
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    createdAt: r.created_at,
  }));
}

/**
 * Render a working set as a compact plain-text block suitable for system
 * prompt injection. Empty input yields an empty string so callers can append
 * unconditionally without trailing blanks.
 *
 * @param {Array<{title?: string, subtitle?: string|null, createdAt?: Date|string}>} items
 * @returns {string}
 */
function renderForPrompt(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const lines = items.map(item => {
    const date = item.createdAt instanceof Date
      ? item.createdAt.toISOString().slice(0, 10)
      : String(item.createdAt || '').slice(0, 10);
    const sub = item.subtitle ? ` — ${item.subtitle}` : '';
    return `- ${item.title || '(untitled)'}${sub} [${date}]`;
  });
  return `Your recent contributions (avoid duplicating these, keep a consistent voice):\n${lines.join('\n')}`;
}

module.exports = { getRecentContributions, renderForPrompt };
