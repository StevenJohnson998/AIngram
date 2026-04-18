const URL_CHECK_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; AIlore-Curator/1.0; +https://ailore.ai)',
};
const CROSSREF_HEADERS = {
  'User-Agent': 'AIlore-Curator/1.0 (mailto:steven.johnson.ai2@gmail.com)',
};

const DOI_PATTERNS = [
  { re: /dl\.acm\.org\/doi\/(10\.\d+\/.+?)(?:[?#]|$)/, special: false },
  { re: /link\.springer\.com\/article\/(10\.\d+\/.+?)(?:[?#]|$)/, special: false },
  { re: /onlinelibrary\.wiley\.com\/.*\/doi\/(?:abs\/|full\/)?(10\.\d+\/.+?)(?:[?#]|$)/, special: false },
  { re: /doi\.org\/(10\.\d+\/.+?)(?:[?#]|$)/, special: false },
  { re: /ieeexplore\.ieee\.org\/document\/(\d+)/, special: true },
  { re: /nature\.com\/articles\/([a-z0-9-]+)/, special: true },
];

function extractDoi(url) {
  for (const { re, special } of DOI_PATTERNS) {
    const m = url.match(re);
    if (m) return special ? null : m[1];
  }
  return null;
}

async function checkDoiCrossref(doi, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: CROSSREF_HEADERS,
      signal: controller.signal,
    });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} url
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<'link_exists'|'dead'|'unverifiable'>}
 */
async function checkUrl(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (url.includes('arxiv.org/abs/')) {
      const res = await fetch(url, {
        headers: URL_CHECK_HEADERS,
        redirect: 'follow',
        signal: controller.signal,
      });
      if (res.status >= 400) return 'dead';
      const text = await res.text();
      return text.slice(0, 2000).includes('not recognized') ? 'dead' : 'link_exists';
    }

    const doi = extractDoi(url);
    if (doi) {
      const exists = await checkDoiCrossref(doi, timeoutMs);
      return exists ? 'link_exists' : 'dead';
    }

    const res = await fetch(url, {
      method: 'HEAD',
      headers: URL_CHECK_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });
    if (res.status === 403) return 'unverifiable';
    return res.status < 400 ? 'link_exists' : 'dead';
  } catch {
    return 'unverifiable';
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkUrl, extractDoi, checkDoiCrossref };
