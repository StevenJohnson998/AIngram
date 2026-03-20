const { getPool } = require('../config/database');
const { generateEmbedding } = require('./ollama');

/**
 * Map ISO 639-1 codes to PostgreSQL text search configurations.
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
  zh: 'simple',
  hi: 'simple',
  ar: 'simple',
  ja: 'simple',
  ko: 'simple',
  pl: 'simple',
};

/**
 * Resolve a lang code to a PG text search config name.
 */
function pgConfig(lang) {
  return LANG_TO_PG_CONFIG[lang] || 'simple';
}

/**
 * Search chunks by vector cosine similarity.
 * @param {number[]} embedding - 1024-dim vector
 * @param {object} opts
 * @param {number} [opts.limit=20]
 * @param {number} [opts.minSimilarity=0.5]
 * @returns {Array<{id, content, similarity, ...}>}
 */
async function searchByVector(embedding, { limit = 20, minSimilarity = 0.5 } = {}) {
  const pool = getPool();
  const vectorStr = `[${embedding.join(',')}]`;

  const { rows } = await pool.query(
    `SELECT id, content, technical_detail, has_technical_detail, trust_score, status,
            created_by, valid_as_of, created_at, updated_at,
            1 - (embedding <=> $1::vector) as similarity
     FROM chunks
     WHERE embedding IS NOT NULL
       AND 1 - (embedding <=> $1::vector) >= $2
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vectorStr, minSimilarity, limit]
  );

  return rows;
}

/**
 * Full-text search on chunk content using PostgreSQL tsvector.
 * Supports multiple language configs for bilingual search.
 * @param {string} query - search text
 * @param {object} opts
 * @param {number} [opts.limit=20]
 * @param {string[]} [opts.langs=['en']] - ISO 639-1 language codes to search with
 * @returns {Array<{id, content, rank, ...}>}
 */
async function searchByText(query, { limit = 20, langs = ['en'] } = {}) {
  const pool = getPool();
  const configs = langs.map(pgConfig);

  // Build OR condition across all language configs
  // unaccent() normalizes accented characters (e.g. mémoire → memoire) for consistent matching
  const matchParts = configs.map(
    (cfg) => `to_tsvector('${cfg}', unaccent(content)) @@ plainto_tsquery('${cfg}', unaccent($1))`
  );
  const matchCondition = matchParts.length === 1 ? matchParts[0] : `(${matchParts.join(' OR ')})`;

  // Use GREATEST for rank across configs
  const rankParts = configs.map(
    (cfg) => `ts_rank(to_tsvector('${cfg}', unaccent(content)), plainto_tsquery('${cfg}', unaccent($1)))`
  );
  const rankExpr = rankParts.length === 1 ? rankParts[0] : `GREATEST(${rankParts.join(', ')})`;

  const { rows } = await pool.query(
    `SELECT id, content, technical_detail, has_technical_detail, trust_score, status,
            created_by, valid_as_of, created_at, updated_at,
            ${rankExpr} as rank
     FROM chunks
     WHERE ${matchCondition}
     ORDER BY rank DESC
     LIMIT $2`,
    [query, limit]
  );

  return rows;
}

/**
 * Hybrid search combining vector similarity and full-text search.
 * Falls back to text-only if Ollama is unavailable.
 * @param {string} query - search text
 * @param {object} opts
 * @param {number} [opts.limit=20]
 * @param {number} [opts.vectorWeight=0.7]
 * @param {number} [opts.textWeight=0.3]
 * @param {string[]} [opts.langs=['en']] - ISO 639-1 language codes for text search
 */
async function hybridSearch(query, { limit = 20, vectorWeight = 0.7, textWeight = 0.3, langs = ['en'] } = {}) {
  const embedding = await generateEmbedding(query);

  // If Ollama is down, fall back to text-only search
  if (!embedding) {
    console.warn('hybridSearch: Ollama unavailable, falling back to text-only search');
    return searchByText(query, { limit, langs });
  }

  // Run both searches in parallel
  const [vectorResults, textResults] = await Promise.all([
    searchByVector(embedding, { limit, minSimilarity: 0.3 }),
    searchByText(query, { limit, langs }),
  ]);

  // Merge and deduplicate by chunk ID, compute weighted score
  const scoreMap = new Map();

  for (const row of vectorResults) {
    const existing = scoreMap.get(row.id) || { ...row, vectorScore: 0, textScore: 0 };
    existing.vectorScore = parseFloat(row.similarity) || 0;
    scoreMap.set(row.id, existing);
  }

  for (const row of textResults) {
    const existing = scoreMap.get(row.id) || { ...row, vectorScore: 0, textScore: 0 };
    existing.textScore = parseFloat(row.rank) || 0;
    scoreMap.set(row.id, existing);
  }

  // Normalize text scores (ts_rank can be >1) and compute weighted score
  const maxTextScore = Math.max(...[...scoreMap.values()].map((r) => r.textScore), 1);

  const merged = [...scoreMap.values()].map((row) => ({
    ...row,
    score: vectorWeight * row.vectorScore + textWeight * (row.textScore / maxTextScore),
  }));

  // Sort by weighted score descending, apply limit
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, limit);
}

module.exports = { searchByVector, searchByText, hybridSearch, LANG_TO_PG_CONFIG, pgConfig };
