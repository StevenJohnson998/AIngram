/**
 * Sparse fieldset utilities for response shaping.
 *
 * Provides:
 * - parseFields: parse ?fields= query param into a Set
 * - applyFieldset: filter an object to a set of fields
 * - truncateContent: shorten content fields with a truncation flag
 * - stripInternalFields: remove large internal-only fields (embedding, injection metadata)
 */

const ALWAYS_STRIP = new Set(['embedding', 'injection_flags', 'injection_risk_score']);
const MAX_FIELDS = 20;
const FIELDS_RE = /^[a-zA-Z0-9_,]+$/;

/**
 * Parse a raw ?fields= string into a Set of field names.
 * Returns null if the param is absent or empty (meaning "use defaults").
 * Rejects invalid characters and caps at MAX_FIELDS fields.
 *
 * @param {string|undefined} raw - raw query param value
 * @returns {Set<string>|null}
 */
function parseFields(raw) {
  if (!raw || typeof raw !== 'string' || raw.trim() === '') return null;
  if (!FIELDS_RE.test(raw)) return null;
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_FIELDS) return null;
  return new Set(parts);
}

/**
 * Filter a row object to the requested fields.
 *
 * @param {object} row - source object
 * @param {Set<string>|null} fields - requested fields (null = use defaults)
 * @param {object} opts
 * @param {string[]} opts.defaults - fields returned when no ?fields= specified
 * @param {string[]} [opts.always=['id']] - fields always included regardless
 * @returns {object}
 */
function applyFieldset(row, fields, { defaults, always = ['id'] }) {
  const include = fields || new Set(defaults);
  always.forEach(f => include.add(f));

  const result = {};
  for (const key of include) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      result[key] = row[key];
    }
  }
  return result;
}

/**
 * Truncate a content string to maxChars, adding a content_truncated flag.
 * Returns the original string with content_truncated: false if short enough.
 *
 * @param {string|null} content
 * @param {number} [maxChars=200]
 * @returns {{ content: string, content_truncated: boolean }}
 */
function truncateContent(content, maxChars = 200) {
  if (!content || typeof content !== 'string') {
    return { content: content || '', content_truncated: false };
  }
  if (content.length <= maxChars) {
    return { content, content_truncated: false };
  }
  return {
    content: content.slice(0, maxChars),
    content_truncated: true,
  };
}

/**
 * Remove large internal-only fields from a row object in-place.
 * Strips: embedding, injection_flags, injection_risk_score.
 *
 * @param {object} row
 * @returns {object} the same row, mutated
 */
function stripInternalFields(row) {
  for (const field of ALWAYS_STRIP) {
    delete row[field];
  }
  return row;
}

module.exports = { parseFields, applyFieldset, truncateContent, stripInternalFields };
