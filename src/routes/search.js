/**
 * Search routes — full-text, vector, and hybrid search.
 * Supports bilingual search: user's language + English as fallback.
 */

const { Router } = require('express');
const { getPool } = require('../config/database');

const auth = require('../middleware/auth');
const vectorSearch = require('../services/vector-search');
const { VALID_LANGS } = require('../config/constants');

const router = Router();

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
    (cfg) => `to_tsvector('${cfg}', unaccent(c.content)) @@ plainto_tsquery('${cfg}', unaccent(${queryParamRef}))`
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
    return `ts_rank(to_tsvector('${configs[0]}', unaccent(c.content)), plainto_tsquery('${configs[0]}', unaccent(${queryParamRef})))`;
  }
  const parts = configs.map(
    (cfg) => `ts_rank(to_tsvector('${cfg}', unaccent(c.content)), plainto_tsquery('${cfg}', unaccent(${queryParamRef})))`
  );
  return `GREATEST(${parts.join(', ')})`;
}

/**
 * Generate search mode guidance based on query characteristics and current mode.
 * Provides advisory tips to help API consumers choose the best search mode.
 */
function generateSearchGuidance(query, modeUsed) {
  const trimmed = query.trim();
  const words = trimmed.split(/\s+/);
  const wordCount = words.length;
  const isQuestion = /^(how|what|why|when|where|who|which|can|does|is|are)\b/i.test(trimmed);
  const hasExactTerms = /^["'].*["']$/.test(trimmed) || /[A-Z]{2,}/.test(trimmed);

  let tip = null;

  if (modeUsed === 'text') {
    if (isQuestion) {
      tip = 'Your query looks like a question. Try type=vector for semantic matching.';
    } else if (wordCount < 3 && !hasExactTerms) {
      tip = 'Short queries may benefit from type=vector for broader semantic results.';
    }
  } else if (modeUsed === 'vector') {
    if (hasExactTerms || wordCount === 1) {
      tip = 'For exact term matching, try type=text instead.';
    } else if (wordCount > 10) {
      tip = 'Long queries may get better precision with type=hybrid.';
    }
  }
  // No tip for hybrid — it is the most versatile mode

  const guidance = {
    mode_used: modeUsed,
    available_modes: ['text', 'vector', 'hybrid'],
  };
  if (tip) guidance.tip = tip;
  return guidance;
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
    const { q, lang: langParam, type: requestedType = 'text', topicType } = req.query;
    let type = requestedType;
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
      const embedding = await require('../services/ollama').generateEmbedding(q);
      if (!embedding) {
        // Fallback to text search when embedding service is unavailable
        console.warn('[SEARCH] Embedding unavailable, falling back to text search');
        type = 'text';
        // Fall through to text search below
      } else {
        const results = await vectorSearch.searchByVector(embedding, { limit, minSimilarity: 0.3 });
        return res.json({
          data: results,
          pagination: { page, limit, total: results.length },
          search_guidance: {
            ...generateSearchGuidance(q, 'vector'),
            fallback: false,
          },
        });
      }
    }

    if (type === 'hybrid') {
      const results = await vectorSearch.hybridSearch(q, { limit, langs: searchConfigs.map(c => {
        // Reverse map PG config to lang code for the service
        const entry = Object.entries(LANG_TO_PG_CONFIG).find(([, v]) => v === c);
        return entry ? entry[0] : 'en';
      })});
      return res.json({
        data: results,
        pagination: { page, limit, total: results.length },
        search_guidance: generateSearchGuidance(q, 'hybrid'),
      });
    }

    // Full-text search with bilingual support
    const pool = getPool();
    const offset = (page - 1) * limit;

    const conditions = [
      "c.status = 'published'",
      buildFtsCondition(searchConfigs, '$1'),
    ];
    const params = [q];
    let idx = 2;

    // Optional topic-level language filter (from query param, NOT from user pref)
    if (langParam) {
      conditions.push(`t.lang = $${idx++}`);
      params.push(langParam);
    }

    // Optional topic type filter
    if (topicType && ['knowledge', 'course'].includes(topicType)) {
      conditions.push(`t.topic_type = $${idx++}`);
      params.push(topicType);
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
              t.lang AS topic_lang,
              t.topic_type AS topic_type
        FROM chunks c
        JOIN chunk_topics ct ON ct.chunk_id = c.id
        JOIN topics t ON t.id = ct.topic_id
        WHERE ${whereClause}
        ORDER BY c.id
      ) sub
      ORDER BY (sub.rank * COALESCE(sub.trust_score, 0.5)) DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    const guidance = generateSearchGuidance(q, 'text');
    // If we got here via fallback from vector/hybrid, indicate it
    if (requestedType !== 'text' && type === 'text') {
      guidance.fallback = true;
      guidance.fallback_reason = 'Embedding service unavailable, results are from text search.';
    }

    return res.json({
      data: dataResult.rows,
      pagination: { page, limit, total },
      searchLangs: searchConfigs,
      search_guidance: guidance,
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
module.exports.generateSearchGuidance = generateSearchGuidance;
