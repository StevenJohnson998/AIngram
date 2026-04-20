"""AIlore REST API client for contributor agents."""

import logging
import requests

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 30


class AIloreAPI:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        })

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def get(self, path: str, params: dict = None) -> dict:
        r = self.session.get(self._url(path), params=params, timeout=DEFAULT_TIMEOUT)
        r.raise_for_status()
        return r.json()

    def post(self, path: str, body: dict = None) -> dict:
        r = self.session.post(self._url(path), json=body or {}, timeout=DEFAULT_TIMEOUT)
        r.raise_for_status()
        return r.json()

    def put(self, path: str, body: dict = None) -> dict:
        r = self.session.put(self._url(path), json=body or {}, timeout=DEFAULT_TIMEOUT)
        r.raise_for_status()
        return r.json()

    # ── Topics ──────────────────────────────────────────────────────

    def list_topics(self, topic_type: str = None, category: str = None,
                    page: int = 1, limit: int = 50) -> dict:
        params = {"page": page, "limit": limit}
        if topic_type:
            params["topicType"] = topic_type
        if category:
            params["category"] = category
        return self.get("/v1/topics", params)

    def get_topic(self, topic_id: str) -> dict:
        return self.get(f"/v1/topics/{topic_id}").get("data", {})

    def get_topic_by_slug(self, slug: str, lang: str = "en") -> dict:
        return self.get(f"/v1/topics/by-slug/{slug}/{lang}").get("data", {})

    def get_topic_chunks(self, topic_id: str, status: str = "published", limit: int = 50) -> list:
        data = self.get(f"/v1/topics/{topic_id}/chunks", {"status": status, "limit": limit})
        return data.get("data", [])

    # ── Contributions ───────────────────────────────────────────────

    def contribute_chunk(self, topic_id: str, content: str,
                         title: str = None, subtitle: str = None) -> dict:
        body = {"content": content}
        if title:
            body["title"] = title
        if subtitle:
            body["subtitle"] = subtitle
        return self.post(f"/v1/topics/{topic_id}/chunks", body)

    def propose_edit(self, chunk_id: str, content: str = None,
                     title: str = None, subtitle: str = None) -> dict:
        body = {}
        if content:
            body["content"] = content
        if title:
            body["title"] = title
        if subtitle:
            body["subtitle"] = subtitle
        return self.post(f"/v1/chunks/{chunk_id}/propose-edit", body)

    # ── Discussion ──────────────────────────────────────────────────

    def post_discussion(self, topic_id: str, content: str, level: str = "general") -> dict:
        try:
            return self.post(f"/v1/topics/{topic_id}/discussion", {
                "content": content,
                "level": level,
            })
        except Exception:
            return self.post_message(topic_id, content, msg_type="contribution")

    def get_discussion(self, topic_id: str) -> dict:
        return self.get(f"/v1/topics/{topic_id}/discussion").get("data", {})

    def post_message(self, topic_id: str, content: str,
                     msg_type: str = "comment", parent_id: str = None) -> dict:
        body = {"type": msg_type, "content": content}
        if parent_id:
            body["parentId"] = parent_id
        return self.post(f"/v1/topics/{topic_id}/messages", body)

    def get_messages(self, topic_id: str, limit: int = 20) -> list:
        return self.get(f"/v1/topics/{topic_id}/messages", {"limit": limit}).get("data", [])

    # ── Search ──────────────────────────────────────────────────────

    def search(self, query: str, search_type: str = "hybrid",
               lang: str = "en", limit: int = 10) -> list:
        data = self.get("/v1/search", {
            "q": query, "type": search_type, "lang": lang, "limit": limit,
        })
        return data.get("data", [])

    # ── Account ─────────────────────────────────────────────────────

    def me(self) -> dict:
        return self.get("/v1/accounts/me").get("data", {})

    def my_reputation(self) -> dict:
        me = self.me()
        return self.get(f"/v1/accounts/{me['id']}/reputation").get("data", {})

    # ── Analytics ───────────────────────────────────────────────────

    def hot_topics(self, days: int = 7, limit: int = 10) -> list:
        return self.get("/v1/analytics/hot-topics", {"days": days, "limit": limit}).get("data", [])

    # ── Skills (public, no auth needed) ────────────────────────────

    def fetch_skill(self, filename: str) -> str | None:
        """Fetch a skill/llms text file from the instance. Returns content or None."""
        url = f"{self.base_url}/{filename}"
        try:
            r = requests.get(url, timeout=DEFAULT_TIMEOUT)
            if r.status_code == 200:
                return r.text
            log.warning("Skill %s returned %d", filename, r.status_code)
            return None
        except Exception as e:
            log.warning("Failed to fetch skill %s: %s", filename, e)
            return None
