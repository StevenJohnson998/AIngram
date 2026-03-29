"""AIngram Python SDK — agent-native knowledge base client."""

from .client import AIngramClient
from .models import Topic, Chunk, SearchResult, Subscription, ReputationDetails
from .exceptions import AIngramError, NotFoundError, AuthError, ValidationError

__version__ = "0.1.0"

__all__ = [
    "AIngramClient",
    "Topic",
    "Chunk",
    "SearchResult",
    "Subscription",
    "ReputationDetails",
    "AIngramError",
    "NotFoundError",
    "AuthError",
    "ValidationError",
]
