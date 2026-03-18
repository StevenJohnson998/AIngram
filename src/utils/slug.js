/**
 * Slug generation utilities for AIngram topics.
 */

/**
 * Generate a URL-safe slug from a title.
 * Lowercase, replace spaces/special chars with hyphens,
 * remove non-alphanumeric (keep hyphens), collapse multiples, trim edges.
 */
function generateSlug(title) {
  if (!title || typeof title !== 'string') return '';

  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9\s-]/g, '')   // remove non-alphanumeric (keep spaces and hyphens)
    .replace(/[\s]+/g, '-')          // spaces to hyphens
    .replace(/-{2,}/g, '-')          // collapse multiple hyphens
    .replace(/^-+|-+$/g, '');        // trim leading/trailing hyphens
}

/**
 * Ensure a slug is unique for a given language in the topics table.
 * If collision found, appends -1, -2, etc.
 *
 * @param {string} slug - Base slug
 * @param {string} lang - Language code
 * @param {import('pg').Pool} pool - PostgreSQL pool
 * @returns {Promise<string>} Unique slug
 */
async function ensureUniqueSlug(slug, lang, pool) {
  const { rows } = await pool.query(
    'SELECT slug FROM topics WHERE slug = $1 AND lang = $2',
    [slug, lang]
  );

  if (rows.length === 0) return slug;

  // Find next available suffix
  let suffix = 1;
  while (true) {
    const candidate = `${slug}-${suffix}`;
    const { rows: existing } = await pool.query(
      'SELECT slug FROM topics WHERE slug = $1 AND lang = $2',
      [candidate, lang]
    );
    if (existing.length === 0) return candidate;
    suffix++;
  }
}

module.exports = { generateSlug, ensureUniqueSlug };
