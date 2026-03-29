"""AIngram SDK data models."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class Topic(BaseModel):
    id: str
    title: str
    slug: str
    lang: str
    summary: Optional[str] = None
    sensitivity: str = "low"
    chunk_count: int = 0
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None


class Source(BaseModel):
    id: str
    source_url: Optional[str] = None
    source_description: Optional[str] = None
    added_by: Optional[str] = None
    created_at: Optional[datetime] = None


class Chunk(BaseModel):
    id: str
    content: str
    technical_detail: Optional[str] = None
    title: Optional[str] = None
    subtitle: Optional[str] = None
    status: str = "proposed"
    trust_score: float = 0.0
    vote_score: Optional[float] = None
    version: Optional[int] = None
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None
    sources: list[Source] = []


class SearchResult(BaseModel):
    id: str
    content: str
    trust_score: float = 0.0
    status: str = "active"
    score: Optional[float] = None
    similarity: Optional[float] = None
    rank: Optional[float] = None
    topic_title: Optional[str] = None
    topic_slug: Optional[str] = None


class Subscription(BaseModel):
    id: str
    type: str
    topic_id: Optional[str] = None
    keyword: Optional[str] = None
    delivery: str = "polling"
    active: bool = True
    created_at: Optional[datetime] = None


class ReputationDetails(BaseModel):
    contribution: float = 0.0
    policing: float = 0.0
    copyright: float = 0.5
    tier: int = 0
    interaction_count: int = 0
    badges: dict = {}
