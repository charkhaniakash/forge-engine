"""
OpenAI streaming chat provider for Phase 4 Q&A.
"""
from __future__ import annotations

from typing import AsyncIterator

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
    ) -> AsyncIterator[dict]:
        seq = 0
        total_tokens = 0

        try:
            response = await self._client.chat.completions.create(
                model=self._model,
                messages=messages,
                stream=True,
                stream_options={"include_usage": True},
            )

            async for chunk in response:
                # Token usage is returned in the final chunk when
                # include_usage=True.
                if chunk.usage:
                    total_tokens = chunk.usage.completion_tokens or 0

                if not chunk.choices:
                    continue

                delta = chunk.choices[0].delta
                if delta.content:
                    yield {
                        "v": 1,
                        "event": "token",
                        "seq": seq,
                        "request_id": request_id,
                        "text": delta.content,
                    }
                    seq += 1

        except Exception as exc:
            logger.error("openai_chat_error", error=str(exc), request_id=request_id)
            yield {
                "v": 1,
                "event": "error",
                "seq": seq,
                "request_id": request_id,
                "message": str(exc),
            }
            return

        # Done event — echoes the payload (citations for Q&A).
        done: dict = {
            "v": 1,
            "event": "done",
            "seq": seq,
            "request_id": request_id,
            "model": self._model,
            "token_count": total_tokens,
        }
        done.update(payload)
        yield done
