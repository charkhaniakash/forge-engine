"""
OpenAI streaming chat provider.

Supports optional response_format for JSON mode (used by planning pipeline).
"""
from __future__ import annotations

from typing import Any, AsyncIterator

import structlog
from openai import AsyncOpenAI

from src.config import settings

logger = structlog.get_logger()


class OpenAIChatProvider:
    """Streams chat completions using the OpenAI API."""

    def __init__(self) -> None:
        self._client = AsyncOpenAI(api_key=settings.openai_api_key)
        self._model = settings.chat.model

    @property
    def model_name(self) -> str:
        return self._model

    async def stream(
        self,
        messages: list[dict],
        payload: dict,
        request_id: str,
        response_format: dict[str, Any] | None = None,
    ) -> AsyncIterator[dict]:
        seq = 0
        total_tokens = 0

        kwargs: dict[str, Any] = dict(
            model=self._model,
            messages=messages,
            stream=True,
            stream_options={"include_usage": True},
        )
        if response_format:
            kwargs["response_format"] = response_format

        try:
            response = await self._client.chat.completions.create(**kwargs)

            async for chunk in response:
                if chunk.usage:
                    total_tokens = chunk.usage.completion_tokens or 0
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta.content:
                    yield {
                        "v": 1, "event": "token", "seq": seq,
                        "request_id": request_id, "text": delta.content,
                    }
                    seq += 1

        except Exception as exc:
            logger.error("openai_chat_error", error=str(exc), request_id=request_id)
            yield {
                "v": 1, "event": "error", "seq": seq,
                "request_id": request_id, "message": str(exc),
            }
            return

        done: dict = {
            "v": 1, "event": "done", "seq": seq,
            "request_id": request_id, "model": self._model,
            "token_count": total_tokens,
        }
        done.update(payload)
        yield done
