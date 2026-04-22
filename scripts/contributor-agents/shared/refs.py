"""URL and citation validation — strips hallucinated sources before posting."""

import re
import logging
import requests

log = logging.getLogger(__name__)

URL_CHECK_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; AIlore-Contributor/1.0; +https://ailore.ai)"}
CROSSREF_HEADERS = {"User-Agent": "AIlore-Contributor/1.0 (mailto:steven.johnson.ai2@gmail.com)"}

DOI_PATTERNS = [
    (r'dl\.acm\.org/doi/(10\.\d+/.+?)(?:\?|#|$)', None),
    (r'link\.springer\.com/article/(10\.\d+/.+?)(?:\?|#|$)', None),
    (r'onlinelibrary\.wiley\.com/.*/doi/(?:abs/|full/)?(10\.\d+/.+?)(?:\?|#|$)', None),
    (r'doi\.org/(10\.\d+/.+?)(?:\?|#|$)', None),
    (r'ieeexplore\.ieee\.org/document/(\d+)', 'ieee'),
    (r'nature\.com/articles/([a-z0-9\-]+)', 'nature'),
]


def check_doi_crossref(doi: str, timeout: float = 5.0) -> bool:
    try:
        r = requests.get(
            f"https://api.crossref.org/works/{doi}",
            headers=CROSSREF_HEADERS,
            timeout=timeout,
        )
        return r.status_code == 200
    except Exception:
        return False


def extract_doi(url: str) -> str | None:
    for pattern, special in DOI_PATTERNS:
        m = re.search(pattern, url)
        if m:
            if special:
                return None
            return m.group(1)
    return None


def check_url(url: str, timeout: float = 5.0) -> bool | None:
    """Returns True (verified), False (dead/fake), None (unverifiable)."""
    try:
        if "arxiv.org/abs/" in url:
            r = requests.get(url, timeout=timeout, allow_redirects=True, headers=URL_CHECK_HEADERS)
            return r.status_code < 400 and "not recognized" not in r.text[:2000]

        doi = extract_doi(url)
        if doi:
            return check_doi_crossref(doi, timeout)

        r = requests.head(url, timeout=timeout, allow_redirects=True, headers=URL_CHECK_HEADERS)
        if r.status_code == 403:
            return None
        return r.status_code < 400
    except Exception:
        return None


def validate_content_refs(content: str) -> tuple[str, list, list]:
    """Validate all [ref:...;url:...] in new content.
    Returns (cleaned_content, stripped_urls, unverified_urls).
    Dead/fake URLs are stripped. Unverifiable ones are kept but flagged."""
    refs = re.findall(r'(\[ref:[^]]*;url:(https?://[^\];\s]+)[^\]]*\])', content)

    stripped = []
    unverified = []
    for full_ref, url in refs:
        result = check_url(url)
        if result is False:
            log.warning("  Stripping dead/fake URL: %s", url)
            content = content.replace(full_ref, "")
            stripped.append(url)
        elif result is None:
            log.info("  Unverifiable URL (kept): %s", url)
            unverified.append(url)
        else:
            log.info("  Verified URL: %s", url)

    content = re.sub(r'  +', ' ', content).strip()
    return content, stripped, unverified
