/**
 * Search routes — full-text, vector, and hybrid search.
 * Supports bilingual search: user's language + English as fallback.
 */

const { Router } = require('express');
const { getPool } = require('../config/database');

const auth = require('../middleware/auth');

const router = Router();

const VALID_LANGS = [
  'en', 'fr', 'zh', 'hi', 'es', 'ar', 'ja', 'de', 'pt', 'ru', 'ko', 'it', 'nl', 'pl', 'sv', 'tr',
];

/**
 * Map ISO 639-1 codes to PostgreSQL text search configurations.
 * Languages without a built-in PG config fall back to 'simple' (no stemming).
 */
const LANG_TO_PG_CONFIG = {
  en: 'english',
  fr: 'french',
  de: 'german',
  es: 'spanish',
  it: 'italian',
  pt: 'portuguese',
  ru: 'russian',
  nl: 'dutch',
  sv: 'swedish',
  tr: 'turkish',
  // No built-in PG config — use 'simple'
  zh: 'simple',
  hi: 'simple',
  ar: 'simple',
  ja: 'simple',
  ko: 'simple',
  pl: 'simple',
};

/**
 * Get the list of PG text search configs to use for a given user language.
 * Returns [userLangConfig] if lang is 'en', or [userLangConfig, 'english'] otherwise.
 */
function getSearchConfigs(userLang) {
  const pgConfig = LANG_TO_PG_CONFIG[userLang] || 'simple';
  if (userLang === 'en') {
    return [pgConfig]; // just 'english'
  }
  return [pgConfig, 'english'];
}

/**
 * Build a full-text match condition that ORs across multiple PG text search configs.
 * Returns a SQL fragment like:
 *   (to_tsvector('french', c.content) @@ plainto_tsquery('french', $1)
 *    OR to_tsvector('english', c.content) @@ plainto_tsquery('english', $1))
 */
function buildFtsCondition(configs, queryParamRef) {
  const parts = configs.map(
    (cfg) => `to_tsvector('${cfg}', c.content) @@ plainto_tsquery('${cfg}', ${queryParamRef})`
  );
  return `(${parts.join(' OR ')})`;
}

/**
 * Build a ts_rank expression that takes the MAX rank across configs.
 * Returns a SQL fragment like:
 *   GREATEST(ts_rank(to_tsvector('french', c.content), plainto_tsquery('french', $1)),
 *            ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', $1)))
 */
function buildRankExpression(configs, queryParamRef) {
  if (configs.length === 1) {
    return `ts_rank(to_tsvector('${configs[0]}', c.content), plainto_tsquery('${configs[0]}', ${queryParamRef}))`;
  }
  const parts = configs.map(
    (cfg) => `ts_rank(to_tsvector('${cfg}', c.content), plainto_tsquery('${cfg}', ${queryParamRef}))`
  );
  return `GREATEST(${parts.join(', ')})`;
}

/**
 * GET /search?q=...&lang=...&type=hybrid|vector|text&page=1&limit=20
 *
 * Language resolution:
 * 1. If authenticated, use account's lang preference
 * 2. Otherwise, use ?lang query param (default 'en')
 *
 * Bilingual search: if user lang != 'en', search uses BOTH
 * the user's language config AND English, merging results.
 */
router.get('/search', auth.authenticateOptional, async (req, res) => {
  try {
    const { q, lang: langParam, type = 'text' } = req.query;
    let page = parseInt(req.query.page, 10) || 1;
    let limit = parseInt(req.query.limit, 10) || 20;
    if (page < 1) page = 1;
    if (limit < 1) limit = 1;
    if (limit > 100) limit = 100;

    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Query parameter q is required' },
      });
    }

    if (langParam && !VALID_LANGS.includes(langParam)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `Lang must be one of: ${VALID_LANGS.join(', ')}` },
      });
    }

    // Resolve user language: auth > query param > default 'en'
    const userLang = (req.account && req.account.lang) || langParam || 'en';
    const searchConfigs = getSearchConfigs(userLang);

    if (type === 'vector') {
      // TODO: Implement vector search using pgvector embeddings.
      return res.json({
        data: [],
        pagination: { page, limit, total: 0 },
        message: 'Vector search not yet implemented',
      });
    }

    if (type === 'hybrid') {
      // TODO: Implement hybrid search combining vector similarity + full-text ranking.
      return res.json({
        data: [],
        pagination: { page, limit, total: 0 },
        message: 'Hybrid search not yet implemented',
      });
    }

    // Full-text search with bilingual support
    const pool = getPool();
    const offset = (page - 1) * limit;

    const conditions = [
      "c.status = 'active'",
      buildFtsCondition(searchConfigs, '$1'),
    ];
    const params = [q];
    let idx = 2;

    // Optional topic-level language filter (from query param, NOT from user pref)
    if (langParam) {
      conditions.push(`t.lang = $${idx++}`);
      params.push(langParam);
    }

    const whereClause = conditions.join(' AND ');

    // Count
    const countResult = await pool.query(
      `SELECT COUNT(DISTINCT c.id)::int AS total
       FROM chunks c
       JOIN chunk_topics ct ON ct.chunk_id = c.id
       JOIN topics t ON t.id = ct.topic_id
       WHERE ${whereClause}`,
      params
    );
    const total = countResult.rows[0].total;

    // Fetch with ranking (best rank across language configs)
    // Subquery: DISTINCT ON (c.id) requires ORDER BY c.id first
    // Outer query: sort by rank DESC and apply SQL-level pagination
    const rankExpr = buildRankExpression(searchConfigs, '$1');
    const limitIdx = idx++;
    const offsetIdx = idx++;
    params.push(limit, offset);

    const dataResult = await pool.query(
      `SELECT * FROM (
        SELECT DISTINCT ON (c.id)
              c.id, c.content, c.technical_detail, c.has_technical_detail,
              c.trust_score, c.status, c.created_by, c.valid_as_of,
              c.created_at, c.updated_at,
              ${rankExpr} AS rank,
              t.id AS topic_id,
              t.title AS topic_title,
              t.slug AS topic_slug,
              t.lang AS topic_lang
        FROM chunks c
        JOIN chunk_topics ct ON ct.chunk_id = c.id
        JOIN topics t ON t.id = ct.topic_id
        WHERE ${whereClause}
        ORDER BY c.id
      ) sub
      ORDER BY sub.rank DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    return res.json({
      data: dataResult.rows,
      pagination: { page, limit, total },
      searchLangs: searchConfigs,
    });
  } catch (err) {
    console.error('Error searching:', err);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Search failed' },
    });
  }
});

module.exports = router;
module.exports.LANG_TO_PG_CONFIG = LANG_TO_PG_CONFIG;
module.exports.getSearchConfigs = getSearchConfigs;
module.exports.buildFtsCondition = buildFtsCondition;
module.exports.buildRankExpression = buildRankExpression;
