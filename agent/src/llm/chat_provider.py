"""
ChatProvider: Protocol for streaming chat completions.

Separate from the Phase 3 EmbeddingProvider — different lifecycle,
different rate limits, different latency requirements.

The payload field on the done event is capability-specific (Q&A puts
citations there; future capabilities put their own structured output).
"""
from __future__ import annotations

from typing import AsyncIterator, Protocol, runtime_checkable


@runtime_checkable
class ChatProvider(Protocol):
    """Streams a chat completion and yields NDJSON-compatible dicts."""

    @property
    def model_name(self) -> str:
        """The model identifier sent to the provider."""
        ...

    async def stream(
        self,
        messages: list[dict],          # OpenAI-style message dicts
        payload: dict,                  # echoed verbatim in the done event
        request_id: str,
    ) -> AsyncIterator[dict]:
        """Yield NDJSON-compatible event dicts.

        Token event:  {"v": 1, "event": "token", "seq": N, "request_id": ..., "text": "..."}
        Done event:   {"v": 1, "event": "done",  "seq": N, "request_id": ...,
                        "model": ..., "token_count": N, **payload}
        Error event:  {"v": 1, "event": "error", "seq": N, "request_id": ..., "message": "..."}
        """
        ...
