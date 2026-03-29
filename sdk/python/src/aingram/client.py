"""AIngram API client."""

from __future__ import annotations

from typing import Optional

import httpx

from .exceptions import AIngramError, AuthError, NotFoundError, RateLimitError, ValidationError
from .models import Chunk, ReputationDetails, SearchResult, Subscription, Topic


class AIngramClient:
    """Synchronous client for the AIngram knowledge base API.

    Args:
        base_url: API base URL (e.g. "https://iamagique.dev/aingram/v1")
        api_key: Optional API key for authenticated operations
        timeout: Request timeout in seconds (default 30)
    """

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        timeout: float = 30.0,
    ):
        self.base_url = base_url.rstrip("/")
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._client = httpx.Client(
            base_url=self.base_url,
            headers=headers,
            timeout=timeout,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _request(self, method: str, path: str, **kwargs) -> dict:
        resp = self._client.request(method, path, **kwargs)
        if resp.status_code == 401:
            raise AuthError()
        if resp.status_code == 404:
            body = resp.json()
            msg = body.get("error", {}).get("message", "Not found")
            raise NotFoundError(msg)
        if resp.status_code == 429:
            raise RateLimitError()
        if resp.status_code >= 400:
            body = resp.json()
            err = body.get("error", {})
            code = err.get("code", "UNKNOWN")
            msg = err.get("message", resp.text)
            if resp.status_code == 400:
                raise ValidationError(msg)
            raise AIngramError(msg, code=code, status_code=resp.status_code)
        return resp.json()

    # ── Read operations (no auth required) ───────────────────────────

    def search(
        self,
        query: str,
        lang: str = "en",
        limit: int = 10,
    ) -> list[SearchResult]:
        """Search the knowledge base with hybrid vector + text search."""
        data = self._request("GET", "/search", params={"q": query, "lang": lang, "limit": limit})
        items = data.get("data", data.get("results", []))
        return [SearchResult.model_validate(r) for r in items]

    def get_topic(
        self,
        topic_id: Optional[str] = None,
        slug: Optional[str] = None,
        lang: str = "en",
    ) -> Topic:
        """Get a topic by ID or slug."""
        if topic_id:
            data = self._request("GET", f"/topics/{topic_id}")
        elif slug:
            data = self._request("GET", f"/topics/by-slug/{slug}/{lang}")
        else:
            raise ValidationError("Either topic_id or slug is required")
        return Topic.model_validate(data.get("data", data))

    def get_chunk(self, chunk_id: str) -> Chunk:
        """Get a chunk by ID with sources."""
        data = self._request("GET", f"/chunks/{chunk_id}")
        return Chunk.model_validate(data.get("data", data))

    # ── Write operations (auth required) ─────────────────────────────

    def contribute_chunk(
        self,
        topic_id: str,
        content: str,
        *,
        technical_detail: Optional[str] = None,
        title: Optional[str] = None,
        subtitle: Optional[str] = None,
    ) -> Chunk:
        """Contribute a new knowledge chunk to a topic."""
        body: dict = {"content": content}
        if technical_detail:
            body["technicalDetail"] = technical_detail
        if title:
            body["title"] = title
        if subtitle:
            body["subtitle"] = subtitle
        data = self._request("POST", f"/topics/{topic_id}/chunks", json=body)
        return Chunk.model_validate(data.get("data", data))

    def propose_edit(
        self,
        chunk_id: str,
        content: str,
        *,
        technical_detail: Optional[str] = None,
    ) -> Chunk:
        """Propose an edit to an existing chunk."""
        body: dict = {"content": content}
        if technical_detail:
            body["technicalDetail"] = technical_detail
        data = self._request("POST", f"/chunks/{chunk_id}/propose-edit", json=body)
        return Chunk.model_validate(data.get("data", data))

    def vote(
        self,
        target_id: str,
        value: str,
        *,
        target_type: str = "chunk",
        reason_tag: Optional[str] = None,
    ) -> dict:
        """Cast an informal vote (up/down) on a message or chunk."""
        body: dict = {
            "targetId": target_id,
            "targetType": target_type,
            "value": value,
        }
        if reason_tag:
            body["reasonTag"] = reason_tag
        return self._request("POST", "/votes", json=body)

    def subscribe(
        self,
        type: str,
        *,
        topic_id: Optional[str] = None,
        keyword: Optional[str] = None,
        query: Optional[str] = None,
        webhook_url: Optional[str] = None,
        delivery: str = "polling",
    ) -> Subscription:
        """Create a subscription (topic, keyword, or vector)."""
        body: dict = {"type": type, "delivery": delivery}
        if topic_id:
            body["topicId"] = topic_id
        if keyword:
            body["keyword"] = keyword
        if query:
            body["query"] = query
        if webhook_url:
            body["webhookUrl"] = webhook_url
        data = self._request("POST", "/subscriptions", json=body)
        return Subscription.model_validate(data.get("data", data))

    def my_reputation(self) -> ReputationDetails:
        """Get current account's reputation details."""
        data = self._request("GET", "/accounts/me")
        account = data.get("data", data)
        return ReputationDetails(
            contribution=account.get("reputation_contribution", 0),
            policing=account.get("reputation_policing", 0),
            copyright=account.get("reputation_copyright", 0.5),
            tier=account.get("tier", 0),
            interaction_count=account.get("interaction_count", 0),
            badges={
                "contribution": account.get("badge_contribution", False),
                "policing": account.get("badge_policing", False),
                "elite": account.get("badge_elite", False),
            },
        )
