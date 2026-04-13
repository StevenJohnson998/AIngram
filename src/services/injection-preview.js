'use strict';

const { SECURITY_EXAMPLE_RE } = require('./injection-detector');

const DEFAULT_MAX_CHARS = 800;
const ELLIPSIS = '…';

/**
 * Pick the most informative match to center the preview on.
 * Prefer matches outside security-example blocks (they're the real signal);
 * among those, pick the highest weight. Fallback to highest weight overall.
 */
function pickAnchorMatch(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return null;
  const real = matches.filter((m) => !m.inSecurityExample);
  const pool = real.length > 0 ? real : matches;
  return pool.reduce((best, m) => (!best || m.weight > best.weight ? m : best), null);
}

/**
 * Build a windowed preview centered on the highest-weight match.
 *
 * Guarantees:
 * - Window width = min(content.length, maxChars). When content is shorter than
 *   maxChars, the whole content is returned (no trimming).
 * - When the natural centered window would run past the start or end of the
 *   content, the window is shifted (not shrunk) so it stays at the target
 *   width whenever possible.
 * - Ellipsis markers are prepended/appended to indicate trimmed edges.
 * - If a `security-example` block exists in the source but is not visible in
 *   the window, a short hint is prepended so the reviewer knows to consider
 *   the author's convention compliance.
 *
 * @param {string} content - The original user-provided content.
 * @param {Array<{start:number,end:number,weight:number,inSecurityExample?:boolean}>} matches
 * @param {{ maxChars?: number }} [opts]
 * @returns {string} preview
 */
function buildPreview(content, matches, opts = {}) {
  if (typeof content !== 'string' || content.length === 0) return '';
  const maxChars = Math.max(50, opts.maxChars || DEFAULT_MAX_CHARS);

  // Short content: no trimming needed.
  if (content.length <= maxChars) return content;

  const anchor = pickAnchorMatch(matches);

  let start;
  let end;

  if (!anchor) {
    // No positional anchor (e.g. stored content but no matches). Fall back
    // to a leading window so behavior is predictable and deterministic.
    start = 0;
    end = maxChars;
  } else {
    const center = Math.floor((anchor.start + anchor.end) / 2);
    const half = Math.floor(maxChars / 2);
    start = center - half;
    end = start + maxChars;

    // Shift the window if it runs off either edge, keeping width constant
    // whenever the content is long enough to support it.
    if (start < 0) {
      end += -start;
      start = 0;
    }
    if (end > content.length) {
      start -= end - content.length;
      end = content.length;
      if (start < 0) start = 0;
    }
  }

  let slice = content.slice(start, end);
  if (start > 0) slice = ELLIPSIS + slice;
  if (end < content.length) slice = slice + ELLIPSIS;

  // Security-example hint: reviewer needs to know the author followed the
  // convention even if the block itself is outside the window.
  SECURITY_EXAMPLE_RE.lastIndex = 0;
  const blockMatch = SECURITY_EXAMPLE_RE.exec(content);
  if (blockMatch) {
    const blockStart = blockMatch.index;
    const blockEnd = blockStart + blockMatch[0].length;
    const windowCoversBlock = blockStart >= start && blockEnd <= end;
    if (!windowCoversBlock) {
      slice = '[security-example block present in full content] ' + slice;
    }
  }

  return slice;
}

module.exports = { buildPreview };
