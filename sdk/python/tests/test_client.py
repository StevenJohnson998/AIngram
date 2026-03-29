"""Tests for AIngram Python SDK client."""

import pytest
import httpx
import respx

from aingram import AIngramClient
from aingram.exceptions import AuthError, NotFoundError, ValidationError
from aingram.models import Chunk, SearchResult, Topic


BASE_URL = "http://test.local/v1"


@pytest.fixture
def client():
    c = AIngramClient(BASE_URL, api_key="test-key")
    yield c
    c.close()


class TestSearch:
    @respx.mock
    def test_search_returns_results(self, client):
        respx.get(f"{BASE_URL}/search").mock(
            return_value=httpx.Response(200, json={
                "data": [
                    {"id": "c1", "content": "AI governance", "trust_score": 0.8, "status": "active", "score": 0.95},
                    {"id": "c2", "content": "MCP protocol", "trust_score": 0.6, "status": "active", "score": 0.7},
                ],
            })
        )

        results = client.search("governance")
        assert len(results) == 2
        assert isinstance(results[0], SearchResult)
        assert results[0].id == "c1"
        assert results[0].score == 0.95

    @respx.mock
    def test_search_empty(self, client):
        respx.get(f"{BASE_URL}/search").mock(
            return_value=httpx.Response(200, json={"data": []})
        )

        results = client.search("nonexistent")
        assert results == []


class TestGetTopic:
    @respx.mock
    def test_get_topic_by_id(self, client):
        respx.get(f"{BASE_URL}/topics/t1").mock(
            return_value=httpx.Response(200, json={
                "data": {"id": "t1", "title": "AI Safety", "slug": "ai-safety", "lang": "en", "chunk_count": 5},
            })
        )

        topic = client.get_topic(topic_id="t1")
        assert isinstance(topic, Topic)
        assert topic.title == "AI Safety"
        assert topic.chunk_count == 5

    @respx.mock
    def test_get_topic_by_slug(self, client):
        respx.get(f"{BASE_URL}/topics/by-slug/ai-safety/en").mock(
            return_value=httpx.Response(200, json={
                "data": {"id": "t1", "title": "AI Safety", "slug": "ai-safety", "lang": "en"},
            })
        )

        topic = client.get_topic(slug="ai-safety")
        assert topic.slug == "ai-safety"

    @respx.mock
    def test_get_topic_not_found(self, client):
        respx.get(f"{BASE_URL}/topics/missing").mock(
            return_value=httpx.Response(404, json={"error": {"code": "NOT_FOUND", "message": "Topic not found"}})
        )

        with pytest.raises(NotFoundError):
            client.get_topic(topic_id="missing")

    def test_get_topic_no_params(self, client):
        with pytest.raises(ValidationError):
            client.get_topic()


class TestGetChunk:
    @respx.mock
    def test_get_chunk_with_sources(self, client):
        respx.get(f"{BASE_URL}/chunks/c1").mock(
            return_value=httpx.Response(200, json={
                "data": {
                    "id": "c1",
                    "content": "Test chunk",
                    "status": "active",
                    "trust_score": 0.7,
                    "sources": [{"id": "s1", "source_url": "https://example.com"}],
                },
            })
        )

        chunk = client.get_chunk("c1")
        assert isinstance(chunk, Chunk)
        assert chunk.content == "Test chunk"
        assert len(chunk.sources) == 1


class TestContributeChunk:
    @respx.mock
    def test_contribute(self, client):
        respx.post(f"{BASE_URL}/topics/t1/chunks").mock(
            return_value=httpx.Response(201, json={
                "data": {"id": "c-new", "content": "New knowledge", "status": "proposed"},
            })
        )

        chunk = client.contribute_chunk("t1", "New knowledge")
        assert chunk.status == "proposed"

    @respx.mock
    def test_contribute_unauthorized(self, client):
        respx.post(f"{BASE_URL}/topics/t1/chunks").mock(
            return_value=httpx.Response(401, json={"error": {"code": "UNAUTHORIZED"}})
        )

        with pytest.raises(AuthError):
            client.contribute_chunk("t1", "Content")


class TestVote:
    @respx.mock
    def test_cast_vote(self, client):
        respx.post(f"{BASE_URL}/votes").mock(
            return_value=httpx.Response(201, json={"data": {"id": "v1", "value": "up"}})
        )

        result = client.vote("c1", "up")
        assert result["data"]["value"] == "up"


class TestSubscribe:
    @respx.mock
    def test_create_topic_subscription(self, client):
        respx.post(f"{BASE_URL}/subscriptions").mock(
            return_value=httpx.Response(201, json={
                "data": {"id": "sub-1", "type": "topic", "topic_id": "t1", "active": True, "delivery": "polling"},
            })
        )

        sub = client.subscribe("topic", topic_id="t1")
        assert sub.type == "topic"
        assert sub.active is True


class TestMyReputation:
    @respx.mock
    def test_get_reputation(self, client):
        respx.get(f"{BASE_URL}/accounts/me").mock(
            return_value=httpx.Response(200, json={
                "data": {
                    "id": "acc-1",
                    "reputation_contribution": 0.75,
                    "reputation_policing": 0.6,
                    "reputation_copyright": 0.5,
                    "tier": 1,
                    "interaction_count": 42,
                    "badge_contribution": True,
                    "badge_policing": False,
                    "badge_elite": False,
                },
            })
        )

        rep = client.my_reputation()
        assert rep.contribution == 0.75
        assert rep.tier == 1
        assert rep.badges["contribution"] is True
