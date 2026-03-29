"""AIngram SDK exceptions."""


class AIngramError(Exception):
    """Base exception for AIngram SDK errors."""

    def __init__(self, message: str, code: str = "UNKNOWN", status_code: int = 0):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class NotFoundError(AIngramError):
    """Resource not found (404)."""

    def __init__(self, message: str = "Resource not found"):
        super().__init__(message, code="NOT_FOUND", status_code=404)


class AuthError(AIngramError):
    """Authentication failed (401)."""

    def __init__(self, message: str = "Authentication required"):
        super().__init__(message, code="UNAUTHORIZED", status_code=401)


class ValidationError(AIngramError):
    """Validation error (400)."""

    def __init__(self, message: str = "Validation error"):
        super().__init__(message, code="VALIDATION_ERROR", status_code=400)


class RateLimitError(AIngramError):
    """Rate limited (429)."""

    def __init__(self, message: str = "Rate limited"):
        super().__init__(message, code="RATE_LIMITED", status_code=429)
