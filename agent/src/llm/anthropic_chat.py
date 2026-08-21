"""
Anthropic streaming chat provider.

response_format is ignored — JSON output is requested via the system prompt
by the planning pipeline directly.
"""
from __future__ import annotations

from typing import Any, AsyncIterator

import structlog
import anthropic

from src.config import settings

logger = structlog.get_logger()


class AnthropicChatProvider:
    """Streams chat completions using the Anthropic API."""

    def __init__(self, api_key: str | None = None, model: str | None = None) -> None:
        key = api_key if api_key is not None else settings.anthropic_api_key
        if not key:
            raise RuntimeError("Anthropic API key is not set. Add it in Settings → Models.")
        self._client = anthropic.AsyncAnthropic(api_key=key)
        self._model = model or settings.chat.model

    @property
    def model_name(self) -> str:
        return self._model

    async def stream(
        self,
        messages: list[dict],
        payload: dict,
        request_id: str,
        response_format: dict[str, Any] | None = None,  # ignored — use system prompt
        model: str | None = None,
    ) -> AsyncIterator[dict]:
        seq = 0
        total_tokens = 0
        effective_model = model or self._model

        system_parts = [m["content"] for m in messages if m.get("role") == "system"]
        chat_messages = [m for m in messages if m.get("role") != "system"]
        system_prompt = "\n\n".join(system_parts) if system_parts else anthropic.NOT_GIVEN

        try:
            async with self._client.messages.stream(
                model=effective_model,
                max_tokens=4096,
                system=system_prompt,
                messages=chat_messages,
            ) as stream:
                async for text in stream.text_stream:
                    yield {
                        "v": 1, "event": "token", "seq": seq,
                        "request_id": request_id, "text": text,
                    }
                    seq += 1

                final = await stream.get_final_message()
                if final.usage:
                    total_tokens = final.usage.output_tokens or 0

        except Exception as exc:
            logger.error("anthropic_chat_error", error=str(exc), request_id=request_id)
            yield {
                "v": 1, "event": "error", "seq": seq,
                "request_id": request_id, "message": str(exc),
            }
            return

        done: dict = {
            "v": 1, "event": "done", "seq": seq,
            "request_id": request_id, "model": effective_model,
            "token_count": total_tokens,
        }
        done.update(payload)
        yield done
