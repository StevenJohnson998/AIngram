"""Web search via SearXNG (self-hosted on Docker shared network)."""

import logging
import requests

log = logging.getLogger(__name__)

SEARXNG_URL = "http://172.18.0.15:8080"
DEFAULT_TIMEOUT = 15


def web_search(query: str, max_results: int = 10, categories: str = "general") -> list[dict]:
    """Search the web via SearXNG. Returns list of {title, url, content}."""
    try:
        r = requests.get(
            f"{SEARXNG_URL}/search",
            params={
                "q": query,
                "format": "json",
                "categories": categories,
                "language": "en",
            },
            timeout=DEFAULT_TIMEOUT,
        )
        r.raise_for_status()
        results = r.json().get("results", [])
        return [
            {
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "content": item.get("content", ""),
            }
            for item in results[:max_results]
        ]
    except Exception as e:
        log.warning("SearXNG search failed for '%s': %s", query, e)
        return []


def search_multiple(queries: list[str], max_per_query: int = 5) -> list[dict]:
    """Run multiple queries and deduplicate by URL."""
    seen_urls = set()
    all_results = []
    for q in queries:
        for result in web_search(q, max_results=max_per_query):
            if result["url"] not in seen_urls:
                seen_urls.add(result["url"])
                all_results.append(result)
    return all_results
