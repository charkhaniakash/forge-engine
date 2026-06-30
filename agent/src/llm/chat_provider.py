"""
ChatProvider: Protocol for streaming chat completions.

Separate from the Phase 3 EmbeddingProvider — different lifecycle,
different rate limits, different latency requirements.

The payload field on the done event is capability-specific (Q&A puts
citations there; planning puts nothing). The optional response_format
parameter enables JSON mode for structured outputs (planning).
"""
from __future__ import annotations

from typing import Any, AsyncIterator, Protocol, runtime_checkable


@runtime_checkable
class ChatProvider(Protocol):
    """Streams a chat completion and yields NDJSON-compatible dicts."""

    @property
    def model_name(self) -> str:
        """The model identifier sent to the provider."""
        ...

    async def stream(
        self,
        messages: list[dict],
        payload: dict,
        request_id: str,
        response_format: dict[str, Any] | None = None,
    ) -> AsyncIterator[dict]:
        """Yield NDJSON-compatible event dicts.

        response_format: optional provider-specific format hint.
          OpenAI:    {"type": "json_object"} for JSON mode.
          Gemini:    {"type": "json_object"} (mapped to MIME type internally).
          Anthropic: ignored (use system prompt to request JSON).

        Token event:  {"v":1, "event":"token", "seq":N, "request_id":"...", "text":"..."}
        Done event:   {"v":1, "event":"done",  "seq":N, "request_id":"...",
                        "model":"...", "token_count":N, **payload}
        Error event:  {"v":1, "event":"error", "seq":N, "request_id":"...", "message":"..."}
        """
        ...
